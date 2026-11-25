"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconCards, IconSchool, IconTrophy, IconUser } from "@tabler/icons-react";
import { cx } from "../ui/cx";

/**
 * Mobile bottom tabs: the four destinations a player actually moves between.
 *
 * The top bar keeps its seven links (pinned by tests/play-hub.test.mjs) and the
 * hamburger keeps the account menu; this is the surface that makes them usable
 * one-handed on a 390px screen, where a 96px-tall bar plus a drawer was two
 * taps to reach Play.
 *
 * Height comes from `--tabbar-height` and the bottom inset from
 * `env(safe-area-inset-bottom)`, so the bar and the content padding that clears
 * it can never disagree — the same rule `--nav-height` enforces at the top.
 */
const TABS = [
  {
    href: "/play",
    label: "Play",
    Icon: IconCards,
    match: (path: string) =>
      path === "/play" ||
      path.startsWith("/play/") ||
      path === "/solitaire" ||
      path === "/daily",
  },
  {
    href: "/classement",
    label: "Ladder",
    Icon: IconTrophy,
    match: (path: string) => path.startsWith("/classement"),
  },
  {
    href: "/learn",
    label: "Learn",
    Icon: IconSchool,
    match: (path: string) => path.startsWith("/learn"),
  },
  {
    href: "/profil",
    label: "You",
    Icon: IconUser,
    match: (path: string) =>
      path.startsWith("/profil") || path.startsWith("/stats") || path.startsWith("/settings"),
  },
];

export default function MobileTabBar() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Primary"
      data-testid="mobile-tab-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex h-[var(--tabbar-height)] items-stretch">
        {TABS.map(({ href, label, Icon, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]",
                active
                  ? "text-[color:var(--accent-strong)]"
                  : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]",
              )}
            >
              <Icon size={20} aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
