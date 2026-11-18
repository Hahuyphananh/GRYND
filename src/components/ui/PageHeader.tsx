import type { ElementType, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The page's one title block. Replaces the copy-pasted
 * `text-[11px] font-black uppercase tracking-[0.4em]` kicker followed by a
 * `text-4xl font-black` title on `/`, `/play`, `/solitaire`, `/stats`.
 *
 * `size="section"` is the same vocabulary one level down: a settings card's
 * heading is not a different component, it is a smaller heading.
 *
 * Colour comes from the semantic layer only — this component never takes a
 * colour prop, so a new screen cannot introduce a one-off hue here.
 */
export default function PageHeader({
  kicker,
  title,
  description,
  actions,
  icon,
  size = "page",
  as,
  className,
}: {
  kicker?: string;
  /** A node, not just a string: the hero highlights one word in brand cyan. */
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  size?: "page" | "section";
  as?: ElementType;
  className?: string;
}) {
  const Heading: ElementType = as ?? (size === "page" ? "h1" : "h2");
  const isPage = size === "page";

  return (
    <header className={cx(isPage ? "mb-8" : "mb-2", className)}>
      {kicker && (
        <p className="mb-2 text-[11px] font-black uppercase tracking-[0.4em] text-[color:var(--text-muted)]">
          {kicker}
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Heading
          className={cx(
            "flex items-center gap-2 font-black tracking-tight text-[color:var(--text-primary)]",
            isPage ? "text-3xl leading-[0.95] sm:text-4xl" : "text-lg leading-tight",
          )}
        >
          {icon}
          {title}
        </Heading>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p
          className={cx(
            "max-w-2xl text-sm text-[color:var(--text-secondary)]",
            isPage ? "mt-3" : "mt-2",
          )}
        >
          {description}
        </p>
      )}
    </header>
  );
}
