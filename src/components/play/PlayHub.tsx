"use client";

// src/components/play/PlayHub.tsx
//
// THE SIX-MODE PLAY HUB.
//
// Exactly six cards, each pointing at a dedicated lobby. The modes are grouped
// visually (competitive / casual / puzzle) so the difference is legible without
// a legend. No card is a placeholder: every href resolves to a real lobby, and
// the puzzle and AI destinations reuse the existing implementations.

import Link from "next/link";
import type { ReactNode } from "react";
import {
  IconArrowRight,
  IconCalendar,
  IconCards,
  IconInfinity,
  IconPuzzle,
  IconRobot,
  IconTrophy,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import { useTranslation } from "../../hooks/useTranslation";

type ModeId = "solo" | "daily" | "ai" | "ranked" | "dailyPuzzle" | "unlimited";

type Mode = {
  id: ModeId;
  href: string;
  group: "competitive" | "casual" | "puzzle";
  icon: ReactNode;
  tone: string;
};

const MODES: readonly Mode[] = [
  {
    id: "solo",
    href: "/play/solo",
    group: "casual",
    icon: <IconCards size={22} aria-hidden="true" />,
    tone: "border-[#00e5ff]/30 bg-[#00e5ff]/[0.07] text-[#9dd8ff]",
  },
  {
    id: "daily",
    href: "/play/daily",
    group: "casual",
    icon: <IconCalendar size={22} aria-hidden="true" />,
    tone: "border-[#f5ff3b]/30 bg-[#f5ff3b]/[0.06] text-[#ffe9a3]",
  },
  {
    id: "ai",
    href: "/play/ai",
    group: "casual",
    icon: <IconRobot size={22} aria-hidden="true" />,
    tone: "border-violet-400/30 bg-violet-400/[0.07] text-violet-200",
  },
  {
    id: "ranked",
    href: "/play/ranked",
    group: "competitive",
    icon: <IconTrophy size={22} aria-hidden="true" />,
    tone: "border-[#00ffa3]/30 bg-[#00ffa3]/[0.07] text-[#8dffd0]",
  },
  {
    id: "dailyPuzzle",
    href: "/play/daily-puzzle",
    group: "puzzle",
    icon: <IconPuzzle size={22} aria-hidden="true" />,
    tone: "border-sky-400/30 bg-sky-400/[0.07] text-sky-200",
  },
  {
    id: "unlimited",
    href: "/play/unlimited-puzzles",
    group: "puzzle",
    icon: <IconInfinity size={22} aria-hidden="true" />,
    tone: "border-fuchsia-400/30 bg-fuchsia-400/[0.07] text-fuchsia-200",
  },
];

export default function PlayHub() {
  const { t } = useTranslation();
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#040712] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.13),transparent_62%)]"
      />
      <NavigationBar currentPath="/play" />

      <main className="relative mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
          {t("playHub.kicker")}
        </p>
        <h1 className="mt-2 text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl">
          {t("playHub.title")}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/60 sm:text-base">
          {t("playHub.description")}
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODES.map((mode) => (
            <Link
              key={mode.id}
              href={mode.href}
              data-testid={`play-mode-${mode.id}`}
              className="group flex min-h-full flex-col rounded-2xl border border-white/10 bg-[#071128]/85 p-4 transition hover:-translate-y-0.5 hover:border-[#00e5ff]/35 hover:bg-[#081a38] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <span
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border ${mode.tone}`}
                >
                  {mode.icon}
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-white/45">
                  {t(`playHub.cards.${mode.id}.tag`)}
                </span>
              </div>
              <h2 className="mt-3 text-lg font-black tracking-tight text-white">
                {t(`playHub.cards.${mode.id}.title`)}
              </h2>
              <p className="mt-1.5 flex-1 text-xs leading-relaxed text-white/55">
                {t(`playHub.cards.${mode.id}.description`)}
              </p>
              <span className="mt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-white/35">
                {t(`playHub.cards.${mode.id}.meta`)}
              </span>
              <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-extrabold text-[#00e5ff]">
                {t(`playHub.cards.${mode.id}.cta`)}
                <IconArrowRight
                  size={14}
                  aria-hidden="true"
                  className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                />
              </span>
            </Link>
          ))}
        </div>
      </main>

      <Footer />
    </div>
  );
}
