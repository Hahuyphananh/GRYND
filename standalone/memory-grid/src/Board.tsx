// standalone/memory-grid/src/Board.tsx
//
// The grid, and nothing else: presentation only.
//
// Every rule lives in the shared engine behind `./match`; this component cannot
// get a round wrong because it never decides anything. It renders a square of
// tiles in one of five states, and reports taps upward.
//
//   pattern   the lit tiles to memorise (amber)      — memorize phase
//   selected  the player's own reconstruction (cyan) — reconstruct phase
//   reveal    the finished match's pattern (emerald)
//   rest      a face-down tile the player can tap
//   idle      face-down and not tappable (waiting, result, finished)
//
// A selected tile looks IDENTICAL whatever it is hiding, so the animation can
// never tell the player whether a pick is right — that is the game.
//
// The flip is a CSS 3D rotation, not an animation library: one continuous
// rotateY 0° → 180° over 0.18 s, with the logo face pre-rotated so it is hidden
// until the flip lands. The app uses framer-motion for the same effect; a portal
// package keeps React as its only dependency, so the motion is expressed in the
// platform instead.

// The tile face is the shared GRYND logo. `new URL(..., import.meta.url)` is the
// bundler-native way to reference an asset that lives outside this package's
// root: Vite emits it beside the bundle and rewrites this expression to the
// hashed file name, so nothing is fetched from the network at runtime.
const LOGO_URL = new URL("../../../src/images/logo1.png", import.meta.url).href;

export type TileState = "pattern" | "selected" | "reveal" | "rest" | "idle";

export type BoardProps = {
  /** Grid dimension (3, 4, 5 or 6). The board is always square. */
  size: number;
  /** Lit tiles: the memorize pattern, or the answer key on a reveal. */
  active?: number[];
  /** The player's own reconstruction picks. */
  picks?: number[];
  /** Render the lit tiles as the finished-match reveal (emerald). */
  revealed?: boolean;
  /** Tiles can be tapped. */
  interactive?: boolean;
  onToggle?: (index: number) => void;
  /** Accessible prefix for each tile, e.g. "Your reconstruction". */
  label?: string;
};

// One dark outline, a light band along the top and a darker underside, lit from
// the top-left — the same slab language as every other GRYND board. The state
// only picks the hue.
const TILE_TONE: Record<TileState, string> = {
  pattern:
    "border-[color:var(--gr-outline)] bg-[#c98513] shadow-[inset_0_2px_0_rgba(255,232,160,0.5),inset_0_-3px_0_rgba(95,58,2,0.55)]",
  selected:
    "gr-selected border-[color:var(--gr-outline)] bg-[#0f3f63] shadow-[inset_0_2px_0_rgba(150,240,255,0.35),inset_0_-3px_0_rgba(0,45,70,0.5)]",
  reveal:
    "border-[color:var(--gr-outline)] bg-[#10603f] shadow-[inset_0_2px_0_rgba(150,255,205,0.4),inset_0_-3px_0_rgba(0,55,35,0.5)]",
  rest: "cursor-pointer border-[color:var(--gr-outline)] bg-[#0e2743] shadow-[inset_0_2px_0_rgba(255,255,255,0.10),inset_0_-3px_0_rgba(3,8,20,0.55)] hover:-translate-y-px hover:border-[#2f7fb8] hover:bg-[#143555]",
  idle: "border-[color:var(--gr-hairline,#1b2c4a)] bg-[#0a1a33] opacity-80",
};

export default function Board({
  size,
  active = [],
  picks = [],
  revealed = false,
  interactive = false,
  onToggle,
  label = "Memory Grid tiles",
}: BoardProps) {
  const dimension = Math.max(0, Math.trunc(Number(size) || 0));
  const total = dimension * dimension;
  const activeSet = new Set(active);
  const pickSet = new Set(picks);

  return (
    <div
      role="group"
      aria-label={label}
      data-testid="memory-board"
      data-grid-size={dimension}
      className="memory-board-frame mx-auto grid w-full max-w-lg gap-3"
      style={{ gridTemplateColumns: `repeat(${dimension}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: total }, (_, index) => {
        const isLit = activeSet.has(index);
        const isPicked = pickSet.has(index);
        const showFace = isLit || isPicked;

        let state: TileState = "idle";
        if (revealed && isLit) state = "reveal";
        else if (isLit) state = "pattern";
        else if (isPicked) state = "selected";
        else if (interactive) state = "rest";

        return (
          <button
            key={index}
            type="button"
            onClick={() => onToggle?.(index)}
            disabled={!interactive}
            aria-label={`${label} ${index + 1}`}
            aria-pressed={isPicked ? true : undefined}
            data-testid="memory-tile"
            data-tile-state={state}
            data-tile-face={showFace ? "up" : "down"}
            // Focus comes from `.gr-focusable`, so a keyboard player rings every
            // tile the same way whatever its state.
            className={`gr-focusable relative aspect-square select-none overflow-hidden rounded-[4px] border-2 transition-[background-color,border-color,box-shadow] duration-150 [perspective:600px] ${TILE_TONE[state]}`}
          >
            <span
              className="absolute inset-0 [transform-style:preserve-3d] transition-transform duration-[180ms] ease-out motion-reduce:transition-none"
              style={{ transform: `rotateY(${showFace ? 180 : 0}deg)` }}
            >
              {/* Blank back (not lit, not picked) */}
              <span className="absolute inset-0 [backface-visibility:hidden]" />
              {/* Logo face (memorize pattern / your picks / the reveal) */}
              <span className="absolute inset-0 flex items-center justify-center p-1 sm:p-2 [backface-visibility:hidden] [transform:rotateY(180deg)]">
                <img
                  src={LOGO_URL}
                  alt=""
                  draggable={false}
                  className="h-full w-full object-contain"
                />
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
