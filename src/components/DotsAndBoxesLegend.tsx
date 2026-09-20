"use client";

// Dots & Boxes: the board paints a drawn line in the color of whoever drew it,
// so a color answers "who claimed this?". The only question that leaves open is
// which hue belongs to which player — that's what this legend answers, sitting
// directly under the board.
//
// This module also owns how a SEAT is depicted (pfp, or the GRYND logo for the
// AI seat). Keeping `SeatMark` here means the legend and the scoreboard rows
// can never drift apart: a color and a face always mean the same thing.
import FrameAvatar from "./FrameAvatar";
// The GRYND mark for the AI seat. The AI has no users row, so it can never
// resolve an official icon key. Static import so the asset can't go missing
// silently — `.src` is the hashed URL an <img> needs.
import smallLogo from "../images/smalllogo.png";

const SMALL_LOGO_SRC: string = smallLogo.src;

export type DotsAndBoxesSeat = "host" | "guest";

interface SeatMarkProps {
  seat: DotsAndBoxesSeat;
  /** Display name — used as the avatar's alt/initial fallback. */
  name?: string | null;
  /** Official icon key for the seat (human players only). */
  iconKey?: string | null;
  /** Equipped profile frame for the seat (human players only). */
  profileFrame?: unknown;
  /** AI seat: always the GRYND logo, whatever `iconKey` says. */
  isAiGame?: boolean;
  /** Tailwind size classes (e.g. "h-5 w-5"). */
  size?: string;
  className?: string;
}

/**
 * The ONE way a seat is depicted across the Dots & Boxes page: the player's
 * official pfp (the same icon key the board stamps inside their claimed boxes),
 * or the GRYND mark for the AI seat.
 */
export function SeatMark({
  seat,
  name,
  iconKey,
  profileFrame,
  isAiGame = false,
  size = "h-5 w-5",
  className = "",
}: SeatMarkProps) {
  if (seat === "guest" && isAiGame) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={SMALL_LOGO_SRC}
        alt=""
        aria-hidden="true"
        className={`shrink-0 rounded-full bg-black/40 object-contain p-px ${size} ${className}`}
      />
    );
  }
  return (
    <FrameAvatar
      frame={profileFrame}
      iconKey={iconKey || null}
      name={name || undefined}
      size={size}
      className={className}
    />
  );
}

interface DotsAndBoxesLegendProps {
  /** Lead-in text, e.g. "Claimed lines". Localized by the caller. */
  label: string;
  hostName: string;
  guestName: string;
  hostIconKey?: string | null;
  guestIconKey?: string | null;
  hostProfileFrame?: unknown;
  guestProfileFrame?: unknown;
  isAiGame?: boolean;
  /** The viewer's own seat — its chip is outlined so "which one am I?" needs no
   *  extra label. */
  selfSeat?: DotsAndBoxesSeat | null;
  /** Exactly the colors the board paints each player's claimed lines with. */
  hostColor: string;
  guestColor: string;
}

export default function DotsAndBoxesLegend({
  label,
  hostName,
  guestName,
  hostIconKey,
  guestIconKey,
  hostProfileFrame,
  guestProfileFrame,
  isAiGame = false,
  selfSeat = null,
  hostColor,
  guestColor,
}: DotsAndBoxesLegendProps) {
  const seats = [
    {
      seat: "host" as const,
      color: hostColor,
      text: "text-amber-300",
      name: hostName,
      iconKey: hostIconKey,
      profileFrame: hostProfileFrame,
    },
    {
      seat: "guest" as const,
      color: guestColor,
      text: "text-cyan-300",
      name: guestName,
      iconKey: guestIconKey,
      profileFrame: guestProfileFrame,
    },
  ];

  return (
    <div
      data-testid="dnb-color-legend"
      // One compact row: the 9:16 creator shell has no vertical room to spare,
      // so this must fit under the board without stealing board space.
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] font-semibold"
    >
      <span className="uppercase tracking-wide text-white/40">{label}</span>
      {seats.map((entry) => {
        const isSelf = selfSeat === entry.seat;
        return (
          <span
            key={entry.seat}
            data-testid={`dnb-legend-${entry.seat}`}
            data-self={isSelf ? "true" : "false"}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
              isSelf ? "border-white/30 bg-white/10" : "border-white/10 bg-black/30"
            }`}
          >
            {/* Mini drawn edge — the exact color the board paints this
                player's claimed lines with. */}
            <svg
              width="18"
              height="8"
              viewBox="0 0 18 8"
              aria-hidden="true"
              className="shrink-0"
            >
              <line
                data-testid={`dnb-legend-swatch-${entry.seat}`}
                x1="2"
                y1="4"
                x2="16"
                y2="4"
                stroke={entry.color}
                strokeWidth="4"
                strokeLinecap="round"
              />
            </svg>
            <SeatMark
              seat={entry.seat}
              name={entry.name}
              iconKey={entry.iconKey}
              profileFrame={entry.profileFrame}
              isAiGame={isAiGame}
              size="h-4 w-4"
            />
            <span className={`max-w-[9rem] truncate ${entry.text}`}>{entry.name}</span>
          </span>
        );
      })}
    </div>
  );
}
