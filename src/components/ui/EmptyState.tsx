import type { ReactNode } from "react";
import Button from "./Button";
import { cx } from "./cx";

/**
 * "Nothing here yet" with the one action that fixes it. Replaces the scattered
 * dash-only blocks and the signed-out panel that each invented their own
 * spacing, border and CTA styling.
 *
 * This is the product-chrome empty state. `src/components/states/EmptyState`
 * stays where it is for the older data surfaces (it wraps its own StateShell);
 * those migrate here screen by screen rather than in one sweep.
 */
export default function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: string;
  body?: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-8 text-center",
        className,
      )}
    >
      {icon && (
        <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] text-[color:var(--text-secondary)]">
          {icon}
        </span>
      )}
      <p className="text-base font-bold text-[color:var(--text-primary)]">{title}</p>
      {body && (
        <p className="mx-auto mt-2 max-w-md text-sm text-[color:var(--text-secondary)]">{body}</p>
      )}
      {action && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="primary"
            href={action.href}
            onClick={action.href ? undefined : action.onClick}
          >
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
