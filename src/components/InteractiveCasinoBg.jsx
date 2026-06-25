"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import smallLogo from "../images/smalllogo.png";

/* ──────────────────────────────────────────────────────────────────────
 * InteractiveCasinoBg
 * Self-contained, GPU-accelerated SVG background with a tactile cursor
 * interaction (magnetic orb + parallax + press ripples + per-chip lift).
 *
 * Variant prop:
 *   - "hero"   (default) — full-strength for the home hero. Bigger chips,
 *              snappier springs, punchy ripples.
 *   - "subtle"            — gentle setting that doesn't fight a card grid.
 *              Smaller chips, slower springs, smaller ripples.
 *
 * Layering (back → front):
 *   z-1  Deep background : rotating roulette wireframe + neon grid floor
 *   z-2  Midground       : drifting cards / dice / sevens (slight blur)
 *   z-5  Foreground      : detailed chips with cursor parallax + lift
 *   z-6  Cursor orb      : spring-lerped magnetic glow that follows cursor
 *   z-7  Press ripple    : expanding ring on click for tactile feedback
 * ────────────────────────────────────────────────────────────────────── */

const VARIANT_CONFIG = {
  hero: {
    springs: { damping: 28, stiffness: 220, mass: 0.55 },
    parallax: { strong: 36, weak: 14 },
    orb: {
      size: 60, // h-/w- in tailwind units (4px each)
      blur: 4,
      gradient:
        "radial-gradient(circle at center, rgba(0,229,255,0.60), rgba(0,229,255,0.24) 35%, rgba(255,79,216,0.10) 60%, transparent 75%)",
    },
    ripple: { scale: 38, duration: 0.55 },
    chip: {
      sizes: [150, 130, 110, 95],
      hover: { scale: 1.18, rotate: 0 },
      tap: { scale: 0.88 },
    },
  },
  subtle: {
    springs: { damping: 42, stiffness: 130, mass: 0.7 },
    parallax: { strong: 14, weak: 6 },
    orb: {
      size: 52,
      blur: 6,
      gradient:
        "radial-gradient(circle at center, rgba(0,229,255,0.42), rgba(0,229,255,0.16) 40%, rgba(255,79,216,0.06) 65%, transparent 78%)",
    },
    ripple: { scale: 22, duration: 0.45 },
    chip: {
      sizes: [108, 92, 80, 70],
      hover: { scale: 1.06, rotate: 0 },
      tap: { scale: 0.94 },
    },
  },
};

// A friendly cartoon casino chip — used as the foreground depth layer.
const ChipSvg = ({ accent = "#ffd700", rim = "#9b6a00", id = "chip" }) => (
  <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
    <defs>
      <radialGradient id={`${id}-face`} cx="50%" cy="42%" r="60%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
        <stop offset="35%" stopColor={accent} stopOpacity="0.95" />
        <stop offset="100%" stopColor={rim} stopOpacity="1" />
      </radialGradient>
      <linearGradient id={`${id}-edge`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={accent} />
        <stop offset="100%" stopColor={rim} />
      </linearGradient>
    </defs>
    {/* Outer rim with edge ticks */}
    <circle cx="50" cy="50" r="44" fill={`url(#${id}-edge)`} />
    {Array.from({ length: 14 }).map((_, i) => {
      const angle = (i / 14) * Math.PI * 2;
      const x1 = 50 + Math.cos(angle) * 38;
      const y1 = 50 + Math.sin(angle) * 38;
      const x2 = 50 + Math.cos(angle) * 46;
      const y2 = 50 + Math.sin(angle) * 46;
      return (
        <line
          key={i}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="#0a1a3d"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      );
    })}
    {/* Inner ring */}
    <circle cx="50" cy="50" r="32" fill={`url(#${id}-face)`} />
    <circle cx="50" cy="50" r="32" fill="none" stroke="#0a1a3d" strokeWidth="1.5" />
    <circle
      cx="50"
      cy="50"
      r="24"
      fill="none"
      stroke="#ffffff"
      strokeOpacity="0.55"
      strokeWidth="1"
      strokeDasharray="3 4"
    />
    <circle cx="50" cy="50" r="6" fill="#ffffff" fillOpacity="0.85" />
  </svg>
);

// Playing card (red / blue variants).
const CardSvg = ({ suit = "♠", accent = "#00e5ff" }) => (
  <svg viewBox="0 0 64 88" fill="none" aria-hidden="true">
    <rect x="3" y="3" width="58" height="82" rx="8" fill="#ffffff" fillOpacity="0.92" />
    <rect x="3" y="3" width="58" height="82" rx="8" fill="none" stroke={accent} strokeWidth="2" />
    <path
      d="M32 18 C32 18 16 33 16 44 C16 52 23 56 28 54 C30 53.4 31 52.2 32 51 L32 62 L34 62 L34 51 C35 52.2 36 53.4 38 54 C43 56 50 52 50 44 C50 33 32 18 32 18 Z"
      fill={accent}
    />
    <text
      x="11"
      y="20"
      textAnchor="middle"
      fontSize="11"
      fontWeight="700"
      fill={accent}
      fontFamily="serif"
    >
      A
    </text>
    <text
      x="11"
      y="31"
      textAnchor="middle"
      fontSize="10"
      fill={accent}
      fontFamily="serif"
    >
      {suit}
    </text>
  </svg>
);

// Five-side die.
const DiceSvg = ({ accent = "#00e5ff" }) => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect x="4" y="4" width="56" height="56" rx="10" fill="#ffffff" fillOpacity="0.95" />
    <rect x="4" y="4" width="56" height="56" rx="10" fill="none" stroke={accent} strokeWidth="2" />
    <circle cx="17" cy="17" r="3" fill={accent} />
    <circle cx="47" cy="17" r="3" fill={accent} />
    <circle cx="32" cy="32" r="3" fill={accent} />
    <circle cx="17" cy="47" r="3" fill={accent} />
    <circle cx="47" cy="47" r="3" fill={accent} />
  </svg>
);

// Slot-machine "7" inside a rounded badge.
const SevenSvg = ({ accent = "#f5ff3b" }) => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect x="4" y="4" width="56" height="56" rx="12" fill="#ffffff" fillOpacity="0.92" />
    <rect x="4" y="4" width="56" height="56" rx="12" fill="none" stroke={accent} strokeWidth="2" />
    <text
      x="32"
      y="46"
      textAnchor="middle"
      fontSize="40"
      fontWeight="900"
      fill={accent}
      fontFamily="ui-serif, Georgia, serif"
    >
      7
    </text>
  </svg>
);

/**
 * Deep roulette wireframe. Used in the background layer.
 * Drawn large so it dominates the hero without ever feeling busy —
 * opacity is intentionally low so the foreground reads clearly.
 *
 * `uid` is propagated from the host component to keep gradient IDs
 * unique when multiple InteractiveCasinoBg instances co-exist.
 */
const RouletteWireframe = ({ size, uid }) => (
  <svg
    viewBox="0 0 800 800"
    width={size}
    height={size}
    style={{ filter: "blur(0.4px)" }}
    aria-hidden="true"
  >
    <defs>
      <radialGradient id={`${uid}-wheelFade`} cx="50%" cy="50%" r="50%">
        <stop offset="55%" stopColor="#00e5ff" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#ff4fd8" stopOpacity="0.05" />
      </radialGradient>
    </defs>

    {/* Outer rim */}
    <circle cx="400" cy="400" r="380" fill="none" stroke="#00e5ff" strokeOpacity="0.18" strokeWidth="2" />
    <circle cx="400" cy="400" r="360" fill="none" stroke="#00e5ff" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 6" />
    {/* Inner track */}
    <circle cx="400" cy="400" r="300" fill={`url(#${uid}-wheelFade)`} />
    <circle cx="400" cy="400" r="300" fill="none" stroke="#ff4fd8" strokeOpacity="0.4" strokeWidth="2" />

    {/* Numbered pockets — 36 alternating segments */}
    {Array.from({ length: 36 }).map((_, i) => {
      const angle = (i / 36) * Math.PI * 2;
      const next = ((i + 1) / 36) * Math.PI * 2;
      const r1 = 300;
      const r2 = 360;
      const x1 = 400 + Math.cos(angle) * r1;
      const y1 = 400 + Math.sin(angle) * r1;
      const x2 = 400 + Math.cos(angle) * r2;
      const y2 = 400 + Math.sin(angle) * r2;
      const nx = 400 + Math.cos(next) * r2;
      const ny = 400 + Math.sin(next) * r2;
      const colors = ["#ff4fd8", "#0a1a3d", "#00e5ff", "#0a1a3d"];
      const fill = colors[i % colors.length];
      return (
        <path
          key={i}
          d={`M ${x1} ${y1} L ${x2} ${y2} A ${r2} ${r2} 0 0 1 ${nx} ${ny} L ${400 + Math.cos(next) * r1} ${400 + Math.sin(next) * r1} A ${r1} ${r1} 0 0 0 ${x1} ${y1} Z`}
          fill={fill}
          fillOpacity={i % 4 === 0 ? 0.45 : 0.25}
          stroke="#00e5ff"
          strokeOpacity="0.2"
          strokeWidth="0.6"
        />
      );
    })}

    {/* Center hub */}
    <circle cx="400" cy="400" r="80" fill="#041125" fillOpacity="0.85" />
    <circle cx="400" cy="400" r="80" fill="none" stroke="#ffd700" strokeOpacity="0.7" strokeWidth="2" />
    <circle cx="400" cy="400" r="60" fill="none" stroke="#00e5ff" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="4 4" />
    <image
      href={smallLogo}
      x="340"
      y="340"
      width="120"
      height="120"
      preserveAspectRatio="xMidYMid meet"
    />
  </svg>
);

/**
 * Static-friendly fallback layer used on small screens + the subtle variant.
 * Renders a slim SVG stack that preserves the casino aesthetic
 * without paying for the interactive parallax cost.
 */
const MobileStaticBg = ({ variant, uid }) => {
  const chipOpacityMul = variant === "subtle" ? 0.45 : 0.7;
  return (
    <svg
      viewBox="0 0 400 400"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`${uid}-mobRad`} cx="50%" cy="40%" r="65%">
          <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.35" />
          <stop offset="60%" stopColor="#003b8e" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#030817" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="400" fill={`url(#${uid}-mobRad)`} />
      {/* Faint perspective grid */}
      <g opacity={variant === "subtle" ? 0.25 : 0.45} stroke="#00e5ff" strokeWidth="0.6">
        {Array.from({ length: 12 }).map((_, i) => (
          <line key={`mv-${i}`} x1={i * 36} y1="280" x2={200 + (i * 36 - 200) * 2.4} y2="400" />
        ))}
        {Array.from({ length: 7 }).map((_, i) => (
          <line key={`mh-${i}`} x1="0" y1={280 + i * 22} x2="400" y2={280 + i * 22} />
        ))}
      </g>
      {/* Two floating chips */}
      <g opacity={chipOpacityMul}>
        <circle cx="60" cy="80" r="34" fill="#ffd700" fillOpacity="0.6" />
        <circle cx="60" cy="80" r="20" fill="none" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="1.5" />
      </g>
      <g opacity={chipOpacityMul * 0.8}>
        <circle cx="340" cy="120" r="40" fill="#00e5ff" fillOpacity="0.4" />
        <circle cx="340" cy="120" r="24" fill="none" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="1.5" />
      </g>
      <g opacity={chipOpacityMul * 0.85}>
        <rect x="290" y="270" width="56" height="80" rx="6" fill="#ffffff" fillOpacity="0.18" stroke="#ff4fd8" strokeOpacity="0.5" strokeWidth="1.5" />
      </g>
    </svg>
  );
};

export default function InteractiveCasinoBg({ variant = "hero" }) {
  const cfg = VARIANT_CONFIG[variant] ?? VARIANT_CONFIG.hero;
  const reduceMotion = useReducedMotion();
  const containerRef = useRef(null);

  // Each instance gets its own gradient-id prefix so multiple mounted
  // copies (e.g. SSR/hydration, route transitions, test setups) never
  // reference the same `<defs>` IDs.
  const uid = useId();

  // GPU-accelerated cursor tracking — never useState so we don't re-render on move.
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  // Spring-smoothed cursor for the magnetic orb. Tuned per variant for feel.
  const orbX = useSpring(mouseX, cfg.springs);
  const orbY = useSpring(mouseY, cfg.springs);

  // Const-ify the useTransform input arrays so they're not rebuilt every
  // render (cleaner dependency tracking for motion values).
  const strongXs = useMemo(
    () => [cfg.parallax.strong, -cfg.parallax.strong],
    [cfg.parallax.strong],
  );
  const strongYs = useMemo(
    () => [cfg.parallax.strong * 0.65, -cfg.parallax.strong * 0.65],
    [cfg.parallax.strong],
  );
  const weakXs = useMemo(
    () => [-cfg.parallax.weak, cfg.parallax.weak],
    [cfg.parallax.weak],
  );
  const weakYs = useMemo(
    () => [-cfg.parallax.weak * 0.6, cfg.parallax.weak * 0.6],
    [cfg.parallax.weak],
  );

  // Parallax for foreground chips — translate OPPOSITE to cursor.
  const parallaxStrongX = useTransform(orbX, [-1, 1], strongXs);
  const parallaxStrongY = useTransform(orbY, [-1, 1], strongYs);

  // Parallax for the deep background — translate WITH cursor, smaller.
  const parallaxWeakX = useTransform(orbX, [-1, 1], weakXs);
  const parallaxWeakY = useTransform(orbY, [-1, 1], weakYs);

  // Cursor orb position as percentage strings (computed once at top-level).
  const orbLeftPct = useTransform(orbX, (v) => `${(v + 1) * 50}%`);
  const orbTopPct = useTransform(orbY, (v) => `${(v + 1) * 50}%`);

  // Press ripple state. (Each click triggers one re-render; acceptable
  // because the ripple layer is small and isolated.)
  const [ripples, setRipples] = useState([]);
  const rippleTimersRef = useRef(new Set());

  // Clean up any pending ripple timers on unmount.
  useEffect(() => {
    const timers = rippleTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const handlePointerMove = useCallback(
    (event) => {
      if (reduceMotion) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (event.clientX - rect.left) / rect.width; // 0..1
      const y = (event.clientY - rect.top) / rect.height; // 0..1
      mouseX.set(x * 2 - 1); // remap to -1..1
      mouseY.set(y * 2 - 1);
    },
    [mouseX, mouseY, reduceMotion],
  );

  const handlePointerLeave = useCallback(() => {
    if (reduceMotion) return;
    mouseX.set(0);
    mouseY.set(0);
  }, [mouseX, mouseY, reduceMotion]);

  const spawnRipple = useCallback(
    (event) => {
      if (reduceMotion) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setRipples((prev) => [...prev, { id, x, y }]);
      const timer = setTimeout(() => {
        rippleTimersRef.current.delete(timer);
        setRipples((prev) => prev.filter((r) => r.id !== id));
      }, Math.round(cfg.ripple.duration * 1000) + 200);
      rippleTimersRef.current.add(timer);
    },
    [reduceMotion, cfg.ripple.duration],
  );

  // Foreground chips — sizes & positions scaled per variant.
  // ── Window-level pointer listeners ─────────────────────────
  // The wrapper above has `pointer-events:none` so pointer events pass
  // through to underlying buttons (e.g. leaderboard tabs, "Back to home").
  // But that would also kill cursor tracking for the magnetic orb. We
  // keep the existing handler logic and attach the listeners to `window`
  // directly — pointermove still fires there regardless of hit testing.
  // mouseleave on <html> is the closest proxy for "cursor left the page".
  useEffect(() => {
    if (reduceMotion) return;
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerdown", spawnRipple, { passive: true });
    document.documentElement.addEventListener("mouseleave", handlePointerLeave);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", spawnRipple);
      document.documentElement.removeEventListener("mouseleave", handlePointerLeave);
    };
  }, [handlePointerMove, handlePointerLeave, spawnRipple, reduceMotion]);

  const fgChipSizes = cfg.chip.sizes;
  const foregroundChips = useMemo(
    () => [
      { id: "chip-gold", left: "5%", top: "26%", size: fgChipSizes[0], accent: "#ffd700", rim: "#a06a00" },
      { id: "chip-cyan", right: "6%", top: "20%", size: fgChipSizes[1], accent: "#00e5ff", rim: "#0a4a6e" },
      { id: "chip-pink", right: "12%", bottom: "16%", size: fgChipSizes[2], accent: "#ff4fd8", rim: "#7a1f6a" },
      { id: "chip-yellow", left: "14%", bottom: "18%", size: fgChipSizes[3], accent: "#f5ff3b", rim: "#7a7a14" },
    ],
    [fgChipSizes],
  );

  // Midground drifters — independent sine waves + slight blur.
  const midgroundItems = useMemo(
    () => [
      { id: "card-a", left: "20%", top: "12%", size: 62, Svg: CardSvg, suit: "♠", accent: "#00e5ff", floatY: 26, dur: 14, delay: 0.2 },
      { id: "card-b", right: "26%", top: "44%", size: 54, Svg: CardSvg, suit: "♥", accent: "#ff4fd8", floatY: 22, dur: 17, delay: 0.9 },
      { id: "die-a", left: "38%", bottom: "12%", size: 50, Svg: DiceSvg, accent: "#00e5ff", floatY: 18, dur: 11, delay: 0.5 },
      { id: "die-b", right: "38%", bottom: "24%", size: 44, Svg: DiceSvg, accent: "#f5ff3b", floatY: 16, dur: 13, delay: 1.2 },
      { id: "seven-a", left: "44%", top: "62%", size: 46, Svg: SevenSvg, accent: "#f5ff3b", floatY: 20, dur: 15, delay: 1.6 },
      { id: "seven-b", right: "44%", top: "12%", size: 40, Svg: SevenSvg, accent: "#ff4fd8", floatY: 14, dur: 12, delay: 0.8 },
    ],
    [],
  );

  /* ── Sub-components ─────────────────────────────────────────────── */

  const ForegroundChip = ({ chip, idx }) => (
    <motion.div
      className="absolute pointer-events-auto"
      style={{
        left: chip.left,
        right: chip.right,
        top: chip.top,
        bottom: chip.bottom,
        width: chip.size,
        height: chip.size,
        x: parallaxStrongX,
        y: parallaxStrongY,
      }}
      initial={{ opacity: 0, scale: 0.6, rotate: -10 }}
      animate={
        reduceMotion
          ? { opacity: 0.75, scale: 1, rotate: 0 }
          : variant === "subtle"
            ? {
                opacity: [0.5, 0.7, 0.5],
                rotate: [-5, 5, -5],
              }
            : {
                opacity: [0.65, 0.95, 0.75],
                rotate: [-8, 8, -8],
              }
      }
      transition={
        reduceMotion
          ? { duration: 0.2 }
          : {
              duration: 7 + idx * 0.6,
              repeat: Infinity,
              ease: "easeInOut",
              delay: idx * 0.25,
            }
      }
      whileHover={reduceMotion ? undefined : cfg.chip.hover}
      whileTap={reduceMotion ? undefined : cfg.chip.tap}
    >
      <ChipSvg accent={chip.accent} rim={chip.rim} id={`chip-${chip.id}`} />
    </motion.div>
  );

  const MidgroundItem = ({ item }) => {
    const Svg = item.Svg;
    return (
      <motion.div
        key={item.id}
        className="absolute"
        style={{
          left: item.left,
          right: item.right,
          top: item.top,
          bottom: item.bottom,
          width: item.size,
          height: item.size,
          opacity: variant === "subtle" ? 0.28 : 0.42,
          filter: variant === "subtle" ? "blur(1.1px)" : "blur(0.6px)",
        }}
        animate={
          reduceMotion
            ? undefined
            : {
                y: [0, -item.floatY, 0, item.floatY * 0.4, 0],
                rotate: [-6, 6, -6],
              }
        }
        transition={
          reduceMotion
            ? undefined
            : {
                duration: item.dur,
                delay: item.delay,
                repeat: Infinity,
                ease: "easeInOut",
              }
        }
      >
        <Svg suit={item.suit} accent={item.accent} />
      </motion.div>
    );
  };

  /* ── Public render ─────────────────────────────────────────────── */

  const orbSizePx = cfg.orb.size * 4;

  return (
    <>
      {/* Mobile/static fallback (no parallax cost, preserves aesthetic) */}
      <div className="absolute inset-0 z-0 block sm:hidden pointer-events-none" aria-hidden="true">
        <MobileStaticBg variant={variant} uid={uid} />
      </div>

      {/* Interactive desktop background. One pointer listener on the wrapper. */}
      <motion.div
        ref={containerRef}
        className="absolute inset-0 z-0 hidden overflow-hidden pointer-events-none sm:block"
        style={{ willChange: "transform" }}
        aria-hidden="true"
      >
        {/* ── Layer 1 — Deep background : wireframe roulette + grid */}
        <motion.div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            x: parallaxWeakX,
            y: parallaxWeakY,
            opacity: variant === "subtle" ? 0.32 : 0.55,
          }}
        >
          <motion.div
            animate={
              reduceMotion ? undefined : { rotate: [0, 360] }
            }
            transition={
              reduceMotion
                ? undefined
                : { duration: variant === "subtle" ? 35 : 22, repeat: Infinity, ease: "linear" }
            }
            style={{ width: "min(150vh, 1300px)", height: "min(150vh, 1300px)" }}
          >
            <RouletteWireframe size="100%" uid={uid} />
          </motion.div>
        </motion.div>

        {/* ── Layer 2 — Perspective grid floor */}
        <svg
          viewBox="0 0 1200 800"
          preserveAspectRatio="xMidYMax slice"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`${uid}-gridFade`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#00e5ff" stopOpacity="0" />
              <stop offset="60%" stopColor="#00e5ff" stopOpacity={variant === "subtle" ? 0.10 : 0.18} />
              <stop offset="100%" stopColor="#ff4fd8" stopOpacity={variant === "subtle" ? 0.18 : 0.32} />
            </linearGradient>
          </defs>
          <g stroke={`url(#${uid}-gridFade)`} strokeWidth="1">
            {/* Horizontal lines (parallel) */}
            {Array.from({ length: 9 }).map((_, i) => (
              <line
                key={`hg-${i}`}
                x1="0"
                y1={520 + i * 32}
                x2="1200"
                y2={520 + i * 32}
              />
            ))}
            {/* Vanishing-point lines */}
            {Array.from({ length: 16 }).map((_, i) => {
              const t = (i / 15) * 1200;
              return (
                <line
                  key={`vp-${i}`}
                  x1={t}
                  y1="800"
                  x2="600"
                  y2="520"
                />
              );
            })}
          </g>
        </svg>

        {/* ── Layer 3 — Midground drifters */}
        <div className="absolute inset-0">
          {midgroundItems.map((item) => (
            <MidgroundItem key={item.id} item={item} />
          ))}
        </div>

        {/* ── Layer 4 — Foreground chips with parallax + hover/tap */}
        <div className="absolute inset-0">
          {foregroundChips.map((chip, idx) => (
            <ForegroundChip key={chip.id} chip={chip} idx={idx} />
          ))}
        </div>

        {/* ── Layer 5 — Cursor-following magnetic orb (hidden under reduced motion) */}
        {!reduceMotion && (
          <motion.div
            className="pointer-events-none absolute left-0 top-0 rounded-full"
            aria-hidden="true"
            style={{
              left: orbLeftPct,
              top: orbTopPct,
              width: orbSizePx,
              height: orbSizePx,
              translateX: "-50%",
              translateY: "-50%",
              background: cfg.orb.gradient,
              mixBlendMode: "screen",
              filter: `blur(${cfg.orb.blur}px)`,
            }}
          />
        )}

        {/* ── Layer 6 — Press ripples (through AnimatePresence) */}
        <AnimatePresence>
          {ripples.map((ripple) => (
            <motion.span
              key={ripple.id}
              className="pointer-events-none absolute rounded-full border border-[#00e5ff]/85"
              style={{
                left: ripple.x,
                top: ripple.y,
                width: 4,
                height: 4,
                translateX: "-50%",
                translateY: "-50%",
              }}
              initial={{ opacity: 0.85, scale: 0.5 }}
              animate={{ opacity: 0, scale: cfg.ripple.scale }}
              exit={{ opacity: 0 }}
              transition={{ duration: cfg.ripple.duration, ease: "easeOut" }}
            />
          ))}
        </AnimatePresence>

        {/* ── Layer 7 — Vignette to keep content legible (stronger in subtle variant) */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              variant === "subtle"
                ? "radial-gradient(ellipse at center, transparent 35%, rgba(3,8,23,0.78) 90%)"
                : "radial-gradient(ellipse at center, transparent 40%, rgba(3,8,23,0.55) 85%)",
          }}
        />
      </motion.div>
    </>
  );
}
