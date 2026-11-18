import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * A single labelled number. Replaces `UserStatsTabs`'s private StatTile, the
 * home dashboard tiles and the `/stats` tiles, which were three separate
 * implementations of the same object.
 *
 * `tone` carries the meaning (win / loss / gold bonus / accent), never a
 * literal colour, so a tile cannot drift into a one-off hue.
 */
const VALUES = {
  default: "text-[color:var(--text-primary)]",
  accent: "text-[color:var(--accent-strong)]",
  win: "text-[color:var(--state-win)]",
  loss: "text-[color:var(--state-loss)]",
  gold: "text-[color:var(--state-gold)]",
} as const;

export default function StatTile({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: keyof typeof VALUES;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-4",
        className,
      )}
    >
      <p className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--text-muted)]">
        {label}
      </p>
      <p className={cx("mt-1 text-xl font-bold tabular-nums", VALUES[tone])}>{value}</p>
      {hint && <p className="mt-1 text-xs text-[color:var(--text-muted)]">{hint}</p>}
    </div>
  );
}
