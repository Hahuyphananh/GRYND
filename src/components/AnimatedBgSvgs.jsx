"use client";

import React from "react";
import { motion, useReducedMotion } from "framer-motion";

// Casino chip with edge ticks & inner dashed ring
const ChipSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <circle cx="32" cy="32" r="26" stroke="currentColor" strokeWidth="2" />
    <circle cx="32" cy="32" r="20" stroke="currentColor" strokeWidth="1.25" strokeDasharray="3 3" />
    <circle cx="32" cy="32" r="8" fill="currentColor" />
    {Array.from({ length: 12 }).map((_, i) => {
      const angle = (i / 12) * Math.PI * 2;
      const x1 = 32 + Math.cos(angle) * 23;
      const y1 = 32 + Math.sin(angle) * 23;
      const x2 = 32 + Math.cos(angle) * 28;
      const y2 = 32 + Math.sin(angle) * 28;
      return (
        <line
          key={i}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      );
    })}
  </svg>
);

// Ace of spades playing card
const CardSvg = () => (
  <svg viewBox="0 0 64 88" fill="none" aria-hidden="true">
    <rect
      x="4"
      y="4"
      width="56"
      height="80"
      rx="6"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M32 21 C32 21 14 38 14 48 C14 56 21 60 28 58 C30 57.4 31 56 32 55 L32 67 L34 67 L34 55 C35 56 36 57.4 38 58 C45 60 52 56 52 48 C52 38 32 21 32 21 Z"
      fill="currentColor"
    />
    <text
      x="11"
      y="20"
      textAnchor="middle"
      fontSize="10"
      fontWeight="700"
      fill="currentColor"
      fontFamily="serif"
    >
      A
    </text>
    <text
      x="11"
      y="30"
      textAnchor="middle"
      fontSize="9"
      fill="currentColor"
      fontFamily="serif"
    >
      ♠
    </text>
  </svg>
);

// Five-side die
const DiceSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect
      x="6"
      y="6"
      width="52"
      height="52"
      rx="8"
      stroke="currentColor"
      strokeWidth="2"
    />
    <circle cx="18" cy="18" r="3" fill="currentColor" />
    <circle cx="46" cy="18" r="3" fill="currentColor" />
    <circle cx="32" cy="32" r="3" fill="currentColor" />
    <circle cx="18" cy="46" r="3" fill="currentColor" />
    <circle cx="46" cy="46" r="3" fill="currentColor" />
  </svg>
);

// Slot-machine "7" inside a rounded badge
const SevenSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect
      x="4"
      y="4"
      width="56"
      height="56"
      rx="10"
      stroke="currentColor"
      strokeWidth="2"
    />
    <text
      x="32"
      y="44"
      textAnchor="middle"
      fontSize="40"
      fontWeight="800"
      fill="currentColor"
      fontFamily="ui-serif, Georgia, serif"
    >
      7
    </text>
  </svg>
);

// Roulette ball with highlight
const BallSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <defs>
      <radialGradient id="ballGradient" cx="35%" cy="32%" r="65%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
        <stop offset="60%" stopColor="currentColor" stopOpacity="1" />
        <stop offset="100%" stopColor="currentColor" stopOpacity="1" />
      </radialGradient>
    </defs>
    <circle cx="32" cy="32" r="24" fill="url(#ballGradient)" />
  </svg>
);

// 4-point sparkle star
const SparkleSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path
      d="M32 6 L36 28 L58 32 L36 36 L32 58 L28 36 L6 32 L28 28 Z"
      fill="currentColor"
    />
    <circle cx="32" cy="32" r="5" fill="white" fillOpacity="0.6" />
  </svg>
);

// Dollar coin
const CoinSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <circle
      cx="32"
      cy="32"
      r="26"
      stroke="currentColor"
      strokeWidth="2"
      fill="none"
    />
    <circle
      cx="32"
      cy="32"
      r="20"
      stroke="currentColor"
      strokeWidth="1"
      strokeDasharray="2 2"
      fill="none"
    />
    <text
      x="32"
      y="42"
      textAnchor="middle"
      fontSize="26"
      fontWeight="800"
      fill="currentColor"
      fontFamily="ui-serif, Georgia, serif"
    >
      $
    </text>
  </svg>
);

// Heart card suit
const HeartSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path
      d="M32 54 C32 54 8 38 8 22 C8 14 14 8 22 8 C26 8 30 11 32 15 C34 11 38 8 42 8 C50 8 56 14 56 22 C56 38 32 54 32 54 Z"
      fill="currentColor"
    />
  </svg>
);

// Diamond card suit
const DiamondSvg = () => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path
      d="M32 6 L58 32 L32 58 L6 32 Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  </svg>
);

// Configuration: distributed across the hero, varied sizes/colors/motions
const ITEMS = [
  {
    id: "chip-left",
    left: "4%",
    top: "22%",
    size: 110,
    color: "#ffd700",
    opacity: 0.18,
    duration: 18,
    delay: 0,
    floatY: 32,
    rotate: 24,
    Svg: ChipSvg,
  },
  {
    id: "card-right",
    right: "6%",
    top: "16%",
    left: undefined,
    size: 78,
    color: "#ff4fd8",
    opacity: 0.16,
    duration: 22,
    delay: 1.2,
    floatY: 38,
    rotate: 18,
    Svg: CardSvg,
  },
  {
    id: "dice-bottom-left",
    left: "12%",
    bottom: "14%",
    top: undefined,
    size: 64,
    color: "#00e5ff",
    opacity: 0.2,
    duration: 14,
    delay: 0.6,
    floatY: 26,
    rotate: 30,
    Svg: DiceSvg,
  },
  {
    id: "seven-mid-right",
    right: "12%",
    top: "48%",
    left: undefined,
    size: 70,
    color: "#f5ff3b",
    opacity: 0.16,
    duration: 20,
    delay: 2,
    floatY: 28,
    rotate: 16,
    Svg: SevenSvg,
  },
  {
    id: "sparkle-top",
    left: "46%",
    top: "8%",
    size: 36,
    color: "#ffffff",
    opacity: 0.32,
    duration: 9,
    delay: 0.2,
    floatY: 18,
    rotate: 40,
    Svg: SparkleSvg,
  },
  {
    id: "ball-bottom-right",
    right: "18%",
    bottom: "12%",
    top: undefined,
    left: undefined,
    size: 54,
    color: "#ff4fd8",
    opacity: 0.22,
    duration: 12,
    delay: 0.9,
    floatY: 22,
    rotate: 360,
    Svg: BallSvg,
  },
  {
    id: "coin-top-left",
    left: "30%",
    top: "10%",
    size: 50,
    color: "#ffd700",
    opacity: 0.14,
    duration: 16,
    delay: 1.6,
    floatY: 24,
    rotate: 28,
    Svg: CoinSvg,
  },
  {
    id: "heart-far-right",
    right: "30%",
    top: "30%",
    left: undefined,
    size: 38,
    color: "#ff4fd8",
    opacity: 0.22,
    duration: 11,
    delay: 0.4,
    floatY: 20,
    rotate: 22,
    Svg: HeartSvg,
  },
  {
    id: "diamond-left-mid",
    left: "22%",
    top: "60%",
    size: 30,
    color: "#00e5ff",
    opacity: 0.3,
    duration: 10,
    delay: 1.4,
    floatY: 14,
    rotate: 45,
    Svg: DiamondSvg,
  },
  {
    id: "sparkle-2",
    right: "40%",
    bottom: "20%",
    top: undefined,
    left: undefined,
    size: 26,
    color: "#f5ff3b",
    opacity: 0.34,
    duration: 8,
    delay: 0.7,
    floatY: 12,
    rotate: 50,
    Svg: SparkleSvg,
  },
];

export default function AnimatedBgSvgs() {
  const reduceMotion = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[5] hidden overflow-hidden sm:block"
    >
      {ITEMS.map((item) => {
        const {
          id,
          left,
          right,
          top,
          bottom,
          size,
          color,
          opacity,
          duration,
          delay,
          floatY,
          rotate,
          Svg,
        } = item;

        return (
          <motion.div
            key={id}
            className="absolute"
            style={{
              left,
              right,
              top,
              bottom,
              width: size,
              height: size,
              color,
              opacity,
              willChange: "transform",
            }}
            animate={
              reduceMotion
                ? undefined
                : {
                    y: [0, -floatY, 0, floatY * 0.4, 0],
                    rotate:
                      rotate === 360
                        ? [0, 360]
                        : [-rotate / 2, rotate / 2, -rotate / 2],
                  }
            }
            transition={
              reduceMotion
                ? undefined
                : {
                    duration,
                    delay,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }
            }
          >
            <Svg />
          </motion.div>
        );
      })}
    </div>
  );
}
