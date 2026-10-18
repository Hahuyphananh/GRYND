// src/components/game-ui/TurnBanner.tsx
//
// THE SHARED TURN / STATUS BANNER.
//
// ── IT RENDERS THE APP'S OWN INSTRUCTION, IT DOES NOT WRITE ONE ───────────
//
// Every game already derives and translates its own instruction — the
// tic-tac-toe page's "your move / opponent is thinking", Precision's
// `turnBanner` string, Four-In-A-Row's turn line, Mines' "your turn" pill. This
// component receives that EXACT string and only decides how it looks. It holds
// no copy of its own: no "Your turn", no "Waiting for opponent", no fallback
// sentence. That is what keeps translated text in the translation files and out
// of a presentation component, and it is why adopting the banner cannot produce
// a second, differently-worded turn message on the same screen.
//
// ── WHOSE TURN, BEYOND COLOUR ─────────────────────────────────────────────
//
// `tone` sets the accent (your turn = the brand yellow the app already uses for
// "mine", opponent = the seat magenta, waiting = muted ink, ended = neutral),
// and `seat` adds the seat SHAPE cue — circle for seat 1, diamond for seat 2 —
// so the banner still says whose turn it is in greyscale or with colour
// blindness. `message` carries the words; the caller keeps ownership of them.
//
// ── ACCESSIBILITY ─────────────────────────────────────────────────────────
//
// `announce="polite"` (the default) renders `role="status" aria-live="polite"`,
// so a turn change is spoken once without stealing focus; `"assertive"` is
// available for a clock the player must not miss, and `"off"` renders the same
// visual with no live region at all (for a banner inside an already-live
// container, where a second region would announce twice).
//
// ── SHAPES ────────────────────────────────────────────────────────────────
//
// `shape="sharp"` is Four-In-A-Row's HUD language (3px corners, cyan edge) and
// is a supported variant, not a special case: its turn line is the reason the
// yellow "your turn" accent exists as a token.

import type { ReactNode } from "react";

import type { GameBoardShape } from "./GameBoardFrame";
import type { GameSeat } from "./GameCell";

/** What the banner is saying, independent of the words it was given. */
export type TurnBannerTone =
  | "your-turn"
  | "opponent-turn"
  | "waiting"
  | "neutral"
  | "ended";

export type TurnBannerProps = {
  /**
   * The application's own instruction string — already translated, already
   * derived from the match state. Required: the banner never invents copy.
   */
  message: ReactNode;
  tone?: TurnBannerTone;
  /** Adds the seat's shape pip (circle / diamond) beside the message. */
  seat?: GameSeat;
  /** Trailing content as-is: a countdown, a score chip, a small icon. */
  aside?: ReactNode;
  /** Live-region politeness. `"off"` renders a static, unannounced banner. */
  announce?: "polite" | "assertive" | "off";
  /** Tighter type and padding, for a banner sitting inside the board area. */
  dense?: boolean;
  shape?: GameBoardShape;
  className?: string;
  "data-testid"?: string;
};

const TONE_CLASS: Record<TurnBannerTone, string> = {
  // The app's existing "it is your move" accent (Four-In-A-Row's turn line).
  "your-turn": "border-brand-yellow/45 bg-brand-yellow/10 text-brand-yellow",
  "opponent-turn": "border-seat-2/45 bg-seat-2/10 text-seat-2",
  waiting: "border-[color:var(--gr-hairline)] bg-surface-panel/70 text-ink-muted",
  neutral: "border-brand-cyan/35 bg-brand-cyan/10 text-brand-cyan",
  ended: "border-[color:var(--gr-hairline)] bg-surface-raised/60 text-ink-subtle",
};

const RADIUS: Record<GameBoardShape, string> = {
  rounded: "rounded-lg",
  sharp: "rounded-[3px]",
};

export function TurnBanner({
  message,
  tone = "neutral",
  seat = null,
  aside,
  announce = "polite",
  dense = false,
  shape = "rounded",
  className = "",
  "data-testid": testId,
}: TurnBannerProps) {
  return (
    <p
      role={announce === "off" ? undefined : "status"}
      aria-live={announce === "off" ? undefined : announce}
      data-gr-turn-banner=""
      data-tone={tone}
      data-seat={seat ?? ""}
      data-testid={testId}
      className={`inline-flex max-w-full items-center gap-2 border font-bold uppercase ${
        dense
          ? "px-2.5 py-1 text-[11px] tracking-wider"
          : "px-3 py-1.5 text-xs tracking-widest sm:text-sm"
      } ${RADIUS[shape]} ${TONE_CLASS[tone]} ${className}`}
    >
      {seat !== null && (
        <span
          aria-hidden="true"
          data-gr-turn-seat={seat}
          className={`gr-seat ${
            seat === 1 ? "gr-seat--1" : "gr-seat--2"
          } gr-seat-pip shrink-0 [--gr-seat-pip-size:0.6em]`}
        />
      )}
      <span className="min-w-0 truncate">{message}</span>
      {aside && (
        <span className="ml-1 shrink-0 border-l border-current/30 pl-2 font-semibold normal-case tracking-normal opacity-90">
          {aside}
        </span>
      )}
    </p>
  );
}

export default TurnBanner;
