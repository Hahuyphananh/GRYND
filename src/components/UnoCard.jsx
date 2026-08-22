"use client";

// Neon Flush card — front face.
//
// Art direction follows the game's neon diamond reference: a dark navy
// card base with a glowing geometric shape in the center, neon pink/cyan
// accents, and classic card-style corner indicators.
//
//   • Numbers 0–9 map to a shape (0 = circle, 1 = dot, 2 = vertical line,
//     3 = triangle, 4 = square, 5 = pentagon, 6 = hexagon, …)
//   • +2 (DRAIN) = big plus · +4 (SYSTEM CRASH) = plus inside a square
//   • skip (GLITCH) / reverse (LOOP) keep their icons
//   • wild (HACK) = crossed circle with the four colors in each quadrant
//
// The color *names* (red/blue/green/yellow/wild) stay untouched — only the
// visual mapping changes, so no game logic needs to know about this.

// Single source of truth for the Neon Flush palette — shared by the card
// component and the game pages' color picker / current-color indicator.
export const UNO_PALETTE = {
  red: "#FF2D9B", // hot neon pink
  blue: "#38FCFC", // neon cyan
  green: "#00FFA3", // neon mint
  yellow: "#FFD93D", // neon gold
  wild: "#38FCFC", // cyan glow for the wild card
};

// Quadrant order for the wild crossed circle: pink · cyan · mint · gold.
const WILD_QUADRANTS = ["#FF2D9B", "#38FCFC", "#00FFA3", "#FFD93D"];

const SYMBOLS = {
  skip: "⦸", // GLITCH
  reverse: "⇄", // LOOP
};

const LABELS = {
  skip: "GLITCH",
  reverse: "LOOP",
  drawtwo: "DRAIN",
  wild: "HACK",
  wilddrawfour: "SYSTEM CRASH",
};

// Regular n-gon vertices (point-up). The square is rotated 45° so it reads
// as an axis-aligned square rather than a diamond.
function polygonPoints(n, cx = 50, cy = 50, r = 42) {
  const start = n === 4 ? -Math.PI / 4 : -Math.PI / 2;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = start + (Math.PI * 2 * k) / n;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

function Shape({ kind, accent, quadrants }) {
  const glow = `drop-shadow(0 0 4px ${accent})`;
  const outline = {
    fill: "none",
    stroke: accent,
    strokeWidth: 5,
    strokeLinejoin: "round",
    strokeLinecap: "round",
    style: { filter: glow },
  };
  // `quadrants` overrides the wild card's four colors — used when a HACK
  // has been played with a chosen color, so the opponent clearly sees it.
  const wildQuadrants = quadrants || WILD_QUADRANTS;

  if (kind === "circle") {
    return (
      <svg viewBox="0 0 100 100" className="w-10 h-10">
        <circle cx="50" cy="50" r="40" {...outline} />
      </svg>
    );
  }

  if (kind === "dot") {
    return (
      <svg viewBox="0 0 100 100" className="w-10 h-10">
        <circle cx="50" cy="50" r="15" fill={accent} style={{ filter: glow }} />
      </svg>
    );
  }

  if (kind === "line") {
    return (
      <svg viewBox="0 0 100 100" className="w-10 h-10">
        <line x1="50" y1="12" x2="50" y2="88" {...outline} strokeWidth={9} />
      </svg>
    );
  }

  if (kind === "plus") {
    return (
      <svg viewBox="0 0 100 100" className="w-10 h-10">
        <path d="M44 12 H56 V44 H88 V56 H56 V88 H44 V56 H12 V44 H44 Z" {...outline} fill={accent} fillOpacity={0.15} />
      </svg>
    );
  }

  if (kind === "plusSquare") {
    return (
      <svg viewBox="0 0 100 100" className="w-10 h-10">
        <rect x="14" y="14" width="72" height="72" rx="6" {...outline} />
        <path d="M46 30 H54 V46 H70 V54 H54 V70 H46 V54 H30 V46 H46 Z" {...outline} fill={accent} fillOpacity={0.15} />
      </svg>
    );
  }

  if (kind === "wild") {
    // Crossed circle — one neon color per quadrant when in hand. Once
    // played with a chosen color, all quadrants glow that color so the
    // active color reads instantly on both sides of the table.
    return (
      <svg viewBox="0 0 100 100" className="w-10 h-10" style={{ filter: glow }}>
        <path d="M50,50 L50,10 A40,40 0 0 0 10,50 Z" fill={wildQuadrants[0]} />
        <path d="M50,50 L90,50 A40,40 0 0 0 50,10 Z" fill={wildQuadrants[1]} />
        <path d="M50,50 L50,90 A40,40 0 0 0 90,50 Z" fill={wildQuadrants[2]} />
        <path d="M50,50 L10,50 A40,40 0 0 0 50,90 Z" fill={wildQuadrants[3]} />
        <line x1="50" y1="8" x2="50" y2="92" stroke="#0B1226" strokeWidth="6" />
        <line x1="8" y1="50" x2="92" y2="50" stroke="#0B1226" strokeWidth="6" />
        <circle cx="50" cy="50" r="40" fill="none" stroke="#EAF9FF" strokeWidth="5" />
      </svg>
    );
  }

  // Numeric polygons: 3 = triangle, 4 = square, 5 = pentagon, 6 = hexagon, …
  return (
    <svg viewBox="0 0 100 100" className="w-10 h-10">
      <polygon points={polygonPoints(kind)} {...outline} fill={accent} fillOpacity={0.12} />
    </svg>
  );
}

export default function UnoCard({
  color,
  value,
  onClick,
  className = "",
  style,
}) {
  const normalized = String(value).toLowerCase().replace(/\s/g, "");
  const accent = UNO_PALETTE[String(color).toLowerCase()] || UNO_PALETTE.red;

  const isNumber = /^\d+$/.test(normalized);
  const showCorners =
    isNumber || normalized === "drawtwo" || normalized === "wilddrawfour";
  const cornerText = isNumber
    ? String(value)
    : normalized === "drawtwo"
      ? "+2"
      : normalized === "wilddrawfour"
        ? "+4"
        : null;

  let center = null;
  if (isNumber) {
    const n = parseInt(normalized, 10);
    const kind = n === 0 ? "circle" : n === 1 ? "dot" : n === 2 ? "line" : n;
    center = <Shape kind={kind} accent={accent} />;
  } else if (normalized === "drawtwo") {
    center = <Shape kind="plus" accent={accent} />;
  } else if (normalized === "wilddrawfour") {
    center = <Shape kind="plusSquare" accent={accent} />;
  } else if (normalized === "wild") {
    // A wild that has been played carries a concrete color (the backend
    // injects the chosen one) — show it in that color. In-hand wilds keep
    // color "wild"/"black" and show the classic four-color circle.
    const playedWild =
      String(color).toLowerCase() === "red" ||
      String(color).toLowerCase() === "blue" ||
      String(color).toLowerCase() === "green" ||
      String(color).toLowerCase() === "yellow";
    center = (
      <Shape
        kind="wild"
        accent={accent}
        quadrants={playedWild ? [accent, accent, accent, accent] : undefined}
      />
    );
  } else if (normalized === "skip" || normalized === "reverse") {
    // Icons kept as-is, now glowing on the dark base.
    center = (
      <span
        className="text-3xl font-bold text-white leading-none"
        style={{ textShadow: `0 0 10px ${accent}` }}
      >
        {SYMBOLS[normalized]}
      </span>
    );
  } else {
    center = <span className="text-xl font-bold text-white leading-none">{String(value)}</span>;
  }

  const label = LABELS[normalized] || "";

  return (
    <div className="flex flex-col items-center group">
      {/* NEON BORDER WRAPPER */}
      <div
        className="relative rounded-lg p-[2px]
        bg-gradient-to-r from-[#38fcfc] via-[#ff2d9b] to-[#38fcfc]
        group-hover:shadow-[0_0_25px_rgba(255,45,155,0.55)] transition-shadow duration-300"
      >
        {/* BORDER FLOW ANIMATION */}
        <div className="absolute inset-0 pointer-events-none rounded-lg overflow-hidden">
          <div
            className="absolute h-[2px] w-full top-0
            bg-gradient-to-r from-transparent via-[#38fcfc] to-transparent
            animate-borderFlowX"
          />
          <div
            className="absolute h-[2px] w-full bottom-0
            bg-gradient-to-r from-transparent via-[#38fcfc] to-transparent
            animate-borderFlowX reverse"
          />
          <div
            className="absolute w-[2px] h-full left-0
            bg-gradient-to-b from-transparent via-[#38fcfc] to-transparent
            animate-borderFlowY"
          />
          <div
            className="absolute w-[2px] h-full right-0
            bg-gradient-to-b from-transparent via-[#38fcfc] to-transparent
            animate-borderFlowY reverse"
          />
        </div>

        {/* NEON FLUSH CARD */}
        <div
          onClick={(event) => onClick?.(event)}
          className={`w-14 h-20 rounded-lg shadow-lg flex items-center justify-center cursor-pointer select-none transform hover:scale-110 hover:shadow-[0_0_20px_rgba(255,45,155,0.5)] transition-all duration-200 relative overflow-hidden ${className}`}
          style={{
            background: "linear-gradient(160deg, #001a33 0%, #000a18 100%)",
            ...style,
          }}
        >
          {/* Scan-line overlay for the neon effect */}
          <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,rgba(255,45,155,0.05)_50%,transparent_100%)] pointer-events-none" />

          {/* Corner indicators (top-left + bottom-right, classic card style) */}
          {showCorners && cornerText && (
            <>
              <span
                className="absolute top-1 left-1.5 text-[10px] font-black leading-none z-10"
                style={{ color: accent, textShadow: `0 0 6px ${accent}` }}
              >
                {cornerText}
              </span>
              <span
                className="absolute bottom-1 right-1.5 text-[10px] font-black leading-none rotate-180 z-10"
                style={{ color: accent, textShadow: `0 0 6px ${accent}` }}
              >
                {cornerText}
              </span>
            </>
          )}

          {/* Center shape */}
          <div className="relative z-[5] flex items-center justify-center">{center}</div>
        </div>
      </div>

      {/* Card label */}
      <div className="mt-1 text-center text-white text-xs">
        <span className="text-[#00e5ff]">{color}</span> {label || value}
      </div>
    </div>
  );
}
