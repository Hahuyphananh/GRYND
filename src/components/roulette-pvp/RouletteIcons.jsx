// src/components/roulette-pvp/RouletteIcons.jsx
//
// Inline SVG icon set for the Roulette PvP feature. Replaces emoji glyphs
// with proper vector icons so the lobby and match pages render with a
// professional casino feel. Every icon accepts `className` so callers
// can size + colour them with regular Tailwind utilities. `aria-hidden`
// is on by default — icons used for screen readers should pass a
// meaningful label via the `title` prop OR wrap the parent with text.
//
// Style notes:
//   • Stroke-based (Lucide-style) for a clean, modern look that pairs
//     well with the existing Tailwind/Tailwind UI classes.
//   • Defaults to `currentColor` so `text-yellow-300` etc. apply. The
//     few icons that carry palette-specific fills (coin, trophy, …)
//     use Tailwind semantic tokens (gold/cyan/red) to stay on brand.
//   • All viewBoxes are 24×24 so sizing is just `w-{n} h-{n}`.

import React from "react";

const DEFAULT_CLASS = "inline-block align-[-0.125em]";
const STROKE = "currentColor";
const STROKE_WIDTH = 1.75;

// Generic wrapper — keeps the JSDoc and CSS-class defaults consistent
// across the entire icon set without bloating each individual export.
const SvgBase = ({
  children,
  className = "",
  title,
  size = 24,
  fill = "none",
  strokeLinecap = "round",
  strokeLinejoin = "round",
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke={STROKE}
    strokeWidth={STROKE_WIDTH}
    strokeLinecap={strokeLinecap}
    strokeLinejoin={strokeLinejoin}
    className={`${DEFAULT_CLASS} ${className}`.trim()}
    aria-hidden={title ? undefined : true}
    role={title ? "img" : undefined}
  >
    {title ? <title>{title}</title> : null}
    {children}
  </svg>
);

// Reusable radial-gradient definition — referenced by icons that want
// to share a metallic gold fill (coin, trophy cup, etc.).
// We rely on inline <defs> per icon so the file remains a single
// self-contained module; the IDs are namespaced by component name to
// avoid collision if multiple icons mount on the same page.

/**
 * Casino roulette wheel with alternating red/black/green segments and
 * a gold pointer at top. Replaces the 🎰 emoji used in headers.
 */
export function RouletteWheelIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      {/* Outer dark wood rim */}
      <circle cx="12" cy="12" r="10" />
      {/* Inner gold ring */}
      <circle cx="12" cy="12" r="8" />
      {/* Eight segment spokes for visual depth */}
      {Array.from({ length: 8 }).map((_, i) => (
        <line
          key={i}
          x1="12"
          y1="4"
          x2="12"
          y2="20"
          transform={`rotate(${i * 22.5} 12 12)`}
          opacity={0.35}
        />
      ))}
      {/* Centre hub */}
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      {/* Top pointer */}
      <polygon points="12,2 9,7 15,7" fill="currentColor" stroke="none" />
    </SvgBase>
  );
}

/**
 * Stacked-coin token, gold gradient on the rim, soft bevel on the face.
 * Replaces 🪙 across stake / payout / balance labels. Pure SVG — no
 * external assets required.
 */
export function CoinIcon({ className = "", title, size = 24 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`${DEFAULT_CLASS} ${className}`.trim()}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      fill="none"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id="rv-coin-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE382" />
          <stop offset="1" stopColor="#B8860B" />
        </linearGradient>
        <linearGradient id="rv-coin-edge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFD700" />
          <stop offset="1" stopColor="#8B6914" />
        </linearGradient>
      </defs>
      {/* Top oval — rim shadow */}
      <ellipse cx="12" cy="6" rx="8" ry="2.5" fill="url(#rv-coin-edge)" />
      {/* Side band */}
      <path
        d="M4,6 V18 a8,2.5 0 0 0 16,0 V6"
        fill="url(#rv-coin-edge)"
      />
      {/* Front face */}
      <ellipse cx="12" cy="18" rx="8" ry="2.5" fill="url(#rv-coin-face)" />
      {/* Highlight tick at top */}
      <ellipse
        cx="9"
        cy="5.6"
        rx="2"
        ry="0.6"
        fill="#FFFFFF"
        opacity="0.55"
      />
    </svg>
  );
}

/**
 * Crosshair / target. Used for the Open Lobbies header and the Lock-in
 * bets CTA. Replaces 🎯.
 */
export function TargetIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
    </SvgBase>
  );
}

/**
 * Circular-arrow refresh button. Animated spin via className="animate-spin"
 * if desired. Replaces 🔄.
 */
export function RefreshIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <path d="M21 12a9 9 0 0 0-15.5-6.3L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.5 6.3L21 16" />
      <path d="M21 21v-5h-5" />
    </SvgBase>
  );
}

/**
 * Lightning bolt (cyan accent-friendly). Replaces ⚡ in the
 * "Match starting…" banner.
 */
export function BoltIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <polygon
        points="13,2 4,14 11,14 9,22 20,10 13,10"
        fill="currentColor"
        stroke="none"
      />
    </SvgBase>
  );
}

/**
 * Stopwatch / clock face. Replaces 🕒 in the "Waiting for opponent…"
 * panel.
 */
export function ClockIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12,7 12,12 16,14" />
    </SvgBase>
  );
}

/**
 * Trophy with handles. Gold gradient on the cup. Replaces 🎉 on match win.
 */
export function TrophyIcon({ className = "", title, size = 24 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`${DEFAULT_CLASS} ${className}`.trim()}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      fill="none"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id="rv-trophy-cup" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE382" />
          <stop offset="1" stopColor="#B8860B" />
        </linearGradient>
      </defs>
      {/* Handles */}
      <path
        d="M7,5 H4 a2,2 0 0 0 -2,2 v2 a4,4 0 0 0 4,4"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17,5 H20 a2,2 0 0 1 2,2 v2 a4,4 0 0 1 -4,4"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Cup */}
      <path
        d="M7,4 H17 V10 a5,5 0 0 1 -10,0 Z"
        fill="url(#rv-trophy-cup)"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        strokeLinejoin="round"
      />
      {/* Stem + base */}
      <line
        x1="12"
        y1="15"
        x2="12"
        y2="19"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
      />
      <rect
        x="8"
        y="19"
        width="8"
        height="2.5"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      />
      {/* Star highlight */}
      <circle cx="12" cy="8" r="1.4" fill="#FFFFFF" opacity="0.85" />
    </svg>
  );
}

/**
 * Skull silhouette. Used on match loss / elimination rays. Replaces 💀.
 * Two-tone: outer round-shape + black eye sockets + small jaw cutout
 * so the head reads clearly even at small sizes.
 */
export function SkullIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      {/* Cranium */}
      <path
        d="M4,11 a8,8 0 0 1 16,0 v3 a3,3 0 0 1 -3,3 v3 a1,1 0 0 1 -1,1 h-1 v1 a0.5,0.5 0 0 1 -1,0 v-1 h-2 v1 a0.5,0.5 0 0 1 -1,0 v-1 h-1 a1,1 0 0 1 -1,-1 v-3 a3,3 0 0 1 -3,-3 Z"
      />
      {/* Eye sockets */}
      <ellipse
        cx="9"
        cy="11"
        rx="1.6"
        ry="2.2"
        fill="currentColor"
        stroke="none"
      />
      <ellipse
        cx="15"
        cy="11"
        rx="1.6"
        ry="2.2"
        fill="currentColor"
        stroke="none"
      />
      {/* Nose dot */}
      <circle cx="12" cy="14" r="0.6" fill="currentColor" stroke="none" />
    </SvgBase>
  );
}

/**
 * Two arms meeting in the middle with clasping hands. Used on mutual
 * elimination / draw. Replaces 🤝.
 */
export function HandshakeIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      {/* Left forearm */}
      <path d="M2,13 l4,-2 l4,2 v2 l-4,2 l-4,-2 z" />
      {/* Left hand clasping */}
      <path d="M10,11 a2,2 0 0 1 2,2 v0 a2,2 0 0 1 -2,2 l-2,-2 z" />
      {/* Right forearm */}
      <path d="M22,13 l-4,-2 l-4,2 v2 l4,2 l4,-2 z" />
      {/* Right hand clasping */}
      <path d="M14,11 a2,2 0 0 0 -2,2 v0 a2,2 0 0 0 2,2 l2,-2 z" />
      {/* Cuff lines */}
      <line x1="6" y1="11" x2="6" y2="15" />
      <line x1="18" y1="11" x2="18" y2="15" />
    </SvgBase>
  );
}

/**
 * Open book. Replaces 📖 in the rules toggle button.
 */
export function BookIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <path d="M4,5 a2,2 0 0 1 2,-2 h12 v17 H6 a2,2 0 0 1 -2,-2 Z" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="10" x2="16" y2="10" />
      <line x1="8" y1="13" x2="13" y2="13" />
    </SvgBase>
  );
}

/**
 * Checkmark. Replaces ✓ in the bet-locked / submitted indicators.
 * Pairs with the green "submitted" pill.
 */
export function CheckIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <polyline points="4,12 10,18 20,6" />
    </SvgBase>
  );
}

/**
 * Up chevron. Replaces ▲ in the rules toggle.
 */
export function ChevronUpIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <polyline points="6,15 12,9 18,15" />
    </SvgBase>
  );
}

/**
 * Down chevron. Replaces ▼ in the rules toggle.
 */
export function ChevronDownIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <polyline points="6,9 12,15 18,9" />
    </SvgBase>
  );
}

/**
 * Three pulsing dots — busy/loading state. Replaces the literal "…"
 * placeholder used inside disabled buttons while the network round-trip
 * is in flight. Caller should pass `animate-pulse` via className so the
 * dots actually animate.
 */
export function LoadingDotsIcon({ className = "", title, size = 24 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`${DEFAULT_CLASS} ${className}`.trim()}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      fill="currentColor"
    >
      {title ? <title>{title}</title> : null}
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

/**
 * Hand holding a coin (stake/escrow pill). Replaces the loading-state
 * "Joining…" placeholder used on the lobby list.
 */
export function StackCoinIcon({ className = "", title, size = 24 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`${DEFAULT_CLASS} ${className}`.trim()}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      fill="none"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id="rv-stack-coin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE382" />
          <stop offset="1" stopColor="#B8860B" />
        </linearGradient>
      </defs>
      <ellipse cx="12" cy="8" rx="7" ry="2" fill="url(#rv-stack-coin)" />
      <ellipse cx="12" cy="12" rx="7" ry="2" fill="url(#rv-stack-coin)" />
      <ellipse cx="12" cy="16" rx="7" ry="2" fill="url(#rv-stack-coin)" />
    </svg>
  );
}

/**
 * Warning triangle with an exclamation mark. Used for error /
 * not-found views where context is "something went wrong" rather than
 * a win/loss/draw. Keep colour neutral (relies on `currentColor`) so
 * callers can tint red for errors or amber for warnings.
 */
export function AlertIcon({ className = "", title }) {
  return (
    <SvgBase className={className} title={title}>
      <path d="M12,3 L22,20 H2 Z" />
      <line x1="12" y1="10" x2="12" y2="15" />
      <circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </SvgBase>
  );
}

export default {
  RouletteWheel: RouletteWheelIcon,
  Coin: CoinIcon,
  Target: TargetIcon,
  Refresh: RefreshIcon,
  Bolt: BoltIcon,
  Clock: ClockIcon,
  Trophy: TrophyIcon,
  Skull: SkullIcon,
  Handshake: HandshakeIcon,
  Book: BookIcon,
  Check: CheckIcon,
  ChevronUp: ChevronUpIcon,
  ChevronDown: ChevronDownIcon,
  LoadingDots: LoadingDotsIcon,
  StackCoin: StackCoinIcon,
  Alert: AlertIcon,
};
