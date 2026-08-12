// src/lib/slotIcons.jsx
//
// SVG slot-icon set for the Fruit Fortune survival game. Each symbol is
// identified by a STABLE STRING KEY (used by the engine for matching)
// and rendered as a self-contained inline SVG — no emoji text anywhere.
// The engine / server never touch this file; only the client renders
// icons. The 5 symbols form the game's sliding sub-pool.
//
// Keep the keys in SLOT_SYMBOLS in sync with the SLOT_ICONS map below.

export const SLOT_SYMBOLS = [
  "watermelon",
  "banana",
  "pineapple",
  "apple",
  "strawberry",
];

function Svg({ children, className = "", ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      className={className}
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export function WatermelonIcon(props) {
  return (
    <Svg {...props}>
      <path d="M15 45 A35 35 0 0 0 85 45 Z" fill="#ff4d4d" stroke="#2e8b57" strokeWidth="8" strokeLinejoin="round" />
      <circle cx="35" cy="58" r="3" fill="#222" />
      <circle cx="50" cy="68" r="3" fill="#222" />
      <circle cx="65" cy="58" r="3" fill="#222" />
    </Svg>
  );
}

export function BananaIcon(props) {
  return (
    <Svg {...props}>
      <path d="M20 15 C5 65 40 95 90 80 C50 80 35 55 40 10 Z" fill="#ffd700" stroke="#b8860b" strokeWidth="2" strokeLinejoin="round" />
    </Svg>
  );
}

export function PineappleIcon(props) {
  return (
    <Svg {...props}>
      <ellipse cx="50" cy="60" rx="25" ry="35" fill="#ffb300" />
      <path d="M30 50 L70 70 M30 70 L70 50" stroke="#d48806" strokeWidth="3" />
      <path d="M50 25 L30 5 L45 20 L50 0 L55 20 L70 5 Z" fill="#4caf50" />
    </Svg>
  );
}

export function AppleIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="50" cy="55" r="32" fill="#8bc34a" />
      <path d="M50 25 Q55 10 60 10" stroke="#795548" strokeWidth="4" fill="none" />
      <path d="M60 10 Q75 5 70 20 Q60 25 60 10 Z" fill="#4caf50" />
    </Svg>
  );
}

export function StrawberryIcon(props) {
  return (
    <Svg {...props}>
      <path d="M50 90 C20 60 25 35 50 35 C75 35 80 60 50 90 Z" fill="#e53935" />
      <circle cx="40" cy="50" r="2.5" fill="#fff" />
      <circle cx="60" cy="50" r="2.5" fill="#fff" />
      <circle cx="50" cy="65" r="2.5" fill="#fff" />
      <circle cx="50" cy="45" r="2.5" fill="#fff" />
      <path d="M50 35 L30 25 L45 35 L50 15 L55 35 L70 25 Z" fill="#4caf50" />
    </Svg>
  );
}

/** symbol key → icon component */
export const SLOT_ICONS = {
  watermelon: WatermelonIcon,
  banana: BananaIcon,
  pineapple: PineappleIcon,
  apple: AppleIcon,
  strawberry: StrawberryIcon,
};

/** Render the SVG icon for a symbol key (falls back to watermelon). */
export function SlotSymbol({ symbol, className = "" }) {
  const Icon = SLOT_ICONS[symbol] || WatermelonIcon;
  return <Icon className={className} />;
}
