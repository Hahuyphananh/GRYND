"use client";

import Link from "next/link";
import {
  IconCards,
  IconChartBar,
  IconPlayerPlay,
  IconSchool,
} from "@tabler/icons-react";

import { useTranslation } from "../../hooks/useTranslation";

const ITEMS = [
  { id: "courses", href: "/learn/courses", icon: IconSchool },
  { id: "practice", href: "/learn/practice", icon: IconCards },
  { id: "videos", href: "/learn/videos", icon: IconPlayerPlay },
  { id: "coaching", href: "/learn/coaching", icon: IconChartBar },
] as const;

export default function LearnSubnav({
  active,
}: {
  active: "courses" | "practice" | "videos" | "coaching";
}) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("learn.subnav.label")}
      className="mt-4 flex flex-wrap gap-2 border-b border-white/10 pb-3"
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const current = item.id === active;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-extrabold transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
              current
                ? "border-[#00e5ff]/45 bg-[#00e5ff]/15 text-[#d8fbff]"
                : "border-white/10 bg-white/[0.03] text-[#9dd8ff]/75 hover:border-[#00e5ff]/25 hover:text-white"
            }`}
          >
            <Icon size={15} aria-hidden="true" />
            {t(`learn.subnav.${item.id}`)}
          </Link>
        );
      })}
    </nav>
  );
}
