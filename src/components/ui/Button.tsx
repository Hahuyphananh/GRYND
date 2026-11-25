import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The product's one button. `href` renders a link with the identical feel, so
 * a navigation action and a form action stop being two different components.
 *
 * Variants map to semantic tokens: `primary` is the ranked accent (a FILL with
 * dark ink on it), `danger` is the loss state. No variant takes a colour.
 */
const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors duration-fast ease-standard " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)] " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const VARIANTS = {
  primary:
    "bg-[color:var(--accent)] text-[color:var(--on-accent)] hover:bg-[color:var(--accent-strong)]",
  secondary:
    "border border-[color:var(--border-strong)] text-[color:var(--text-primary)] hover:bg-[color:var(--bg-panel)]",
  ghost:
    "text-[color:var(--text-secondary)] hover:bg-[color:var(--bg-panel)] hover:text-[color:var(--text-primary)]",
  danger:
    "border border-[color:var(--state-loss)] text-[color:var(--state-loss)] hover:bg-[color:var(--bg-panel)]",
} as const;

const SIZES = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-sm font-extrabold",
} as const;

export default function Button({
  children,
  variant = "primary",
  size = "md",
  href,
  className,
  type = "button",
  ...rest
}: {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  /** Renders a next/link instead of a <button>, with the same styling. */
  href?: string;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  const classes = cx(BASE, VARIANTS[variant], SIZES[size], className);

  if (href) {
    return (
      <Link
        href={href}
        className={classes}
        data-sound-hover={variant === "primary" ? "" : undefined}
      >
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type}
      className={classes}
      {...rest}
      data-sound-hover={variant === "primary" ? "" : undefined}
    >
      {children}
    </button>
  );
}
