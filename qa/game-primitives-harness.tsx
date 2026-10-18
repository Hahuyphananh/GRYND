// qa/game-primitives-harness.tsx
//
// Mounts the shared game primitives in every state that qa/game-primitives-check.mjs
// measures: the two frame shapes, all five cell states, ownership on both seats,
// a 9-column responsive board, an overhanging label, every piece silhouette on
// both seats, and every banner tone (including the silent one).
//
// It renders the REAL components against the REAL stylesheet (globals.css plus
// the shipped Tailwind output), so the check can read computed styles — which is
// the only way to prove a token actually reaches the browser: a class name in the
// markup proves nothing, and neither does an SSR string.

import { createRoot } from "react-dom/client";

import {
  GameBoardFrame,
  GameCell,
  GamePiece,
  TurnBanner,
} from "../src/components/game-ui";

const GAP = "gap-cell";

const SILHOUETTES = ["disc", "tile", "diamond", "hex", "bar", "card", "spike", "glyph"] as const;

function Fixture({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section data-fixture={id} className="p-3">
      <h2 className="mb-2 text-xs uppercase tracking-widest text-ink-muted">{id}</h2>
      {children}
    </section>
  );
}

function App() {
  return (
    <main className="min-h-screen bg-surface-page p-3 text-ink">
      {/* ── the rounded frame, with one cell per state ───────────────────── */}
      <Fixture id="frame-rounded">
        <GameBoardFrame
          label="Rounded board"
          data-testid="frame-rounded"
          maxWidth={22}
          contentClassName={`grid grid-cols-3 ${GAP}`}
        >
          <GameCell data-testid="cell-default" label="cell default" />
          <GameCell data-testid="cell-occupied" label="cell occupied" occupied />
          <GameCell data-testid="cell-legal" label="cell legal" legalMove onSelect={() => {}} />
          <GameCell data-testid="cell-selected" label="cell selected" selected onSelect={() => {}} />
          <GameCell data-testid="cell-disabled" label="cell disabled" disabled onSelect={() => {}} />
          <GameCell data-testid="cell-owner-1" label="cell owned" owner={1} occupied />
          <GameCell data-testid="cell-owner-2" label="cell owned" owner={2} occupied />
          <GameCell
            data-testid="cell-touch"
            label="cell touch"
            touchTarget
            legalMove
            onSelect={() => {}}
          />
          <GameCell data-testid="cell-offered" label="cell offered" onSelect={() => {}}>
            <span data-testid="cell-offered-mark">X</span>
          </GameCell>

          {/* the opt-out: an oblong cell, sized by its game */}
          <GameCell
            data-testid="cell-oblong"
            label="cell oblong"
            square={false}
            className="h-6 w-full"
            onSelect={() => {}}
          />

          {/* a label that overhangs its cell — it must not be clipped */}
          <GameCell data-testid="cell-overhang" label="cell overhang" className="relative">
            <span
              data-testid="overhang-label"
              className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-state-selected px-1 text-[10px] font-bold text-ink-on-accent"
            >
              +3
            </span>
          </GameCell>
        </GameBoardFrame>
      </Fixture>

      {/* ── the sharp HUD frame, the Four-In-A-Row language ──────────────── */}
      <Fixture id="frame-sharp">
        <GameBoardFrame
          label="Sharp board"
          data-testid="frame-sharp"
          shape="sharp"
          accent="corners"
          maxWidth={16}
          contentClassName={`grid grid-cols-3 ${GAP}`}
        >
          <GameCell data-testid="sharp-cell" label="sharp cell" shape="sharp" onSelect={() => {}} />
          <GameCell label="sharp legal" shape="sharp" legalMove onSelect={() => {}} />
          <GameCell label="sharp owner" shape="sharp" owner={2} occupied />
        </GameBoardFrame>
      </Fixture>

      {/* ── a 9-column board: the tightest real grid, for the 320px check ── */}
      <Fixture id="frame-nine">
        <GameBoardFrame
          label="Nine by nine"
          data-testid="frame-nine"
          maxWidth="min(100%, 36rem)"
          contentClassName={`grid grid-cols-9 ${GAP}`}
        >
          {Array.from({ length: 81 }, (_, i) => (
            <GameCell
              key={i}
              data-testid={i === 0 ? "nine-cell-first" : undefined}
              label={`cell ${i}`}
              legalMove={i < 5}
              onSelect={() => {}}
            />
          ))}
        </GameBoardFrame>
      </Fixture>

      {/* ── every silhouette, on both seats ─────────────────────────────── */}
      <Fixture id="pieces">
        <div className="flex flex-wrap items-center gap-3">
          {SILHOUETTES.map((silhouette) => (
            <GamePiece
              key={`${silhouette}-1`}
              data-testid={`piece-${silhouette}-1`}
              silhouette={silhouette}
              seat={1}
              size="lg"
              label={`${silhouette} seat 1`}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {SILHOUETTES.map((silhouette) => (
            <GamePiece
              key={`${silhouette}-2`}
              data-testid={`piece-${silhouette}-2`}
              silhouette={silhouette}
              seat={2}
              size="lg"
              label={`${silhouette} seat 2`}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <GamePiece data-testid="piece-neutral" silhouette="spike" size="md" />
          <GamePiece data-testid="piece-glyph" silhouette="glyph" seat={1} size="md" label="chess">
            <svg viewBox="0 0 24 24" className="h-full w-full">
              <path d="M8 20h8l-1-6 2 1-2-5H9l-2 5 2-1z" fill="currentColor" />
            </svg>
          </GamePiece>
          <GamePiece data-testid="piece-fill" silhouette="disc" seat={1} />
        </div>
      </Fixture>

      {/* ── banners ──────────────────────────────────────────────────────── */}
      <Fixture id="banners">
        <div className="flex flex-col items-start gap-2">
          <TurnBanner data-testid="banner-yours" message="Your move" tone="your-turn" seat={1} />
          <TurnBanner
            data-testid="banner-theirs"
            message="Opponent is choosing"
            tone="opponent-turn"
            seat={2}
            aside={<span data-testid="banner-timer">0:12</span>}
          />
          <TurnBanner data-testid="banner-waiting" message="Waiting for a seat" tone="waiting" />
          <TurnBanner
            data-testid="banner-dense"
            message="Round 3"
            tone="neutral"
            dense
            shape="sharp"
          />
          <TurnBanner data-testid="banner-quiet" message="Reconnecting" announce="off" />
          <TurnBanner
            data-testid="banner-ended"
            message="Match settled"
            tone="ended"
            announce="assertive"
          />
        </div>
      </Fixture>
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

// The check flips the theme between measurements: light mode re-points only the
// three ground tokens, so the primitives must follow it with no component change.
(window as unknown as { __gr: unknown }).__gr = {
  setTheme(theme: "dark" | "light" | null) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  },
  ready: true,
};
