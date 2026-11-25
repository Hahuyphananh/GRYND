// src/components/ProBadge.tsx
//
// THE visible GRYND PRO mark: one small chip rendered next to a player's name in
// chat, on every leaderboard row, and on their profile.
//
// WHY THIS EXISTS AT ALL. Every benefit the membership used to grant was
// invisible to other players — no ads, more analysis, a queue tie-break. Players
// who pay for a free-to-play game are paying to support it, and competitive
// players want that support to be legible. A badge is the cheapest honest way to
// make it legible: it states a fact the server already knows, and it changes
// nothing about a match.
//
// IT IS PRESENTATIONAL ONLY. No hooks, no client state, no entitlement check —
// the caller passes what the SERVER resolved (lib/proStatus.ts), so a badge
// cannot be conjured by editing markup, and a free account's own DOM never
// contains one.
//
// `FOUNDER` is a variant of the same badge for members who joined during the
// founding window (see proBadgeFor). Same meaning, earned earlier.

export type ProBadgeProps = {
  /** Render the founder variant instead of "PRO". */
  founder?: boolean;
  /** Override the text (e.g. a full membership name in a wide surface). */
  label?: string;
  /** Accessible label; defaults to the meaning of the variant. */
  title?: string;
  /** Extra classes for spacing/alignment at the call site. */
  className?: string;
  /** `sm` sits inline in a name row; `lg` is the profile header. */
  size?: "sm" | "lg";
};

export default function ProBadge({
  founder = false,
  label,
  title,
  className = "",
  size = "sm",
}: ProBadgeProps) {
  const text = (label || (founder ? "FOUNDER" : "PRO")).trim();
  const accessibleTitle =
    title ||
    (founder
      ? "GRYND PRO founder — one of the first players funding independent competitive gaming"
      : "GRYND PRO member — supporting independent competitive gaming");

  return (
    <span
      // A stable hook for the contract tests and for QA: a surface that shows a
      // member's name is expected to render exactly one of these.
      data-testid="pro-badge"
      data-founder={founder ? "true" : "false"}
      title={accessibleTitle}
      aria-label={accessibleTitle}
      className={[
        "inline-flex shrink-0 items-center gap-1 rounded-full border font-black uppercase tracking-wider align-middle",
        founder
          ? "border-[#f5ff3b]/80 bg-gradient-to-r from-[#ffd700] to-[#f5ff3b] text-[#241c00] shadow-[0_0_12px_rgba(245,255,59,0.45)]"
          : "border-[#00ffa6]/70 bg-[#00ffa6]/15 text-[#8affcd] shadow-[0_0_10px_rgba(0,255,166,0.28)]",
        size === "lg" ? "px-2.5 py-1 text-[11px]" : "px-1.5 py-0.5 text-[9px]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span aria-hidden="true">{founder ? "★" : "◆"}</span>
      {text}
    </span>
  );
}
