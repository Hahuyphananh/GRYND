"use client";

// src/components/play/ModeLobby.tsx
//
// One consistent lobby structure for the mode pages that need a new lobby:
// back link to Play, mode identity, description, status slot, primary action and
// an honest note. The action href is resolved here so no page can point at a
// missing experience; /play/ai and /play/ranked reuse their existing screens.

import Link from "next/link";
import type { ReactNode } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCalendar,
  IconCards,
  IconPuzzle,
  IconRobot,
  IconTrophy,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import { useTranslation } from "../../hooks/useTranslation";

export type LobbyMode = "solo" | "daily" | "ai" | "ranked" | "dailyPuzzle";

const MODE_META: Record<
  LobbyMode,
  { href: string; icon: ReactNode; tone: string }
> = {
  solo: {
    href: "/solitaire",
    icon: <IconCards size={22} aria-hidden="true" />,
    tone: "border-[#00e5ff]/30 bg-[#00e5ff]/[0.07] text-[#9dd8ff]",
  },
  daily: {
    href: "/daily",
    icon: <IconCalendar size={22} aria-hidden="true" />,
    tone: "border-[#f5ff3b]/30 bg-[#f5ff3b]/[0.06] text-[#ffe9a3]",
  },
  ai: {
    href: "/casino/solitaire-duel/play-ai",
    icon: <IconRobot size={22} aria-hidden="true" />,
    tone: "border-violet-400/30 bg-violet-400/[0.07] text-violet-200",
  },
  ranked: {
    href: "/casino/solitaire-duel",
    icon: <IconTrophy size={22} aria-hidden="true" />,
    tone: "border-[#00ffa3]/30 bg-[#00ffa3]/[0.07] text-[#8dffd0]",
  },
  dailyPuzzle: {
    href: "/play/daily-puzzle/play",
    icon: <IconPuzzle size={22} aria-hidden="true" />,
    tone: "border-sky-400/30 bg-sky-400/[0.07] text-sky-200",
  },
};

export default function ModeLobby({
  mode,
  children,
  secondary,
}: {
  mode: LobbyMode;
  children?: ReactNode;
  secondary?: ReactNode;
}) {
  const { t } = useTranslation();
  const meta = MODE_META[mode];
  const prefix = `playHub.lobby.${mode}`;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#040712] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.11),transparent_62%)]"
      />
      <NavigationBar currentPath="/play" />

      <main className="relative mx-auto max-w-4xl px-4 pt-24 sm:px-6 md:pt-28">
        <Link
          href="/play"
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 transition hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          {t("playHub.back")}
        </Link>

        <section
          aria-labelledby={`lobby-${mode}-title`}
          data-testid={`play-lobby-${mode}`}
          className="mt-4 rounded-2xl border border-white/10 bg-[#06152f]/90 p-5 sm:p-6"
        >
          <div className="flex items-start gap-3">
            <span
              className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${meta.tone}`}
            >
              {meta.icon}
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#00e5ff]/75">
                {t(`${prefix}.kicker`)}
              </p>
              <h1
                id={`lobby-${mode}-title`}
                className="mt-1 text-3xl font-black tracking-tight sm:text-4xl"
              >
                {t(`${prefix}.title`)}
              </h1>
            </div>
          </div>

          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/60">
            {t(`${prefix}.description`)}
          </p>

          {children && (
            <div className="mt-5" data-testid={`play-lobby-${mode}-status`}>
              {children}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Link
              href={meta.href}
              data-testid={`play-lobby-${mode}-cta`}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-5 py-2.5 text-sm font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              {t(`${prefix}.cta`)}
              <IconArrowRight size={16} aria-hidden="true" />
            </Link>
            {secondary}
          </div>

          <p className="mt-4 border-t border-white/8 pt-3 text-[11px] leading-relaxed text-white/40">
            {t(`${prefix}.note`)}
          </p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
