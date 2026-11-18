"use client";

// src/components/play/ModeLobby.tsx
//
// One consistent lobby structure for the mode pages that need a new lobby:
// back link to Play, mode identity, the mode's own animated table, description,
// status slot, primary action and an honest note. The action href is resolved
// here so no page can point at a missing experience; /play/ai and /play/ranked
// reuse their existing screens.
//
// The lobby wears the SAME palette and the SAME preview as the hub card that
// leads here (src/lib/playModePalette.ts + components/play/ModeTableau): the
// card and the room it opens must not look like two different products. The
// preview is the one instance on the page, so its gradient ids stay unique.

import Link from "next/link";
import type { ReactNode } from "react";
import {
  IconArrowLeft,
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
import ModeTableau from "./ModeTableau";
import {
  PLAY_MODE_PALETTE,
  type PlayModeId,
} from "../../lib/playModePalette";
import { useTranslation } from "../../hooks/useTranslation";

export type LobbyMode = PlayModeId;

const MODE_META: Record<
  LobbyMode,
  { href: string; icon: ReactNode }
> = {
  solo: {
    href: "/solitaire",
    icon: <IconCards size={22} aria-hidden="true" />,
  },
  daily: {
    href: "/daily",
    icon: <IconCalendar size={22} aria-hidden="true" />,
  },
  ai: {
    href: "/play/ai",
    icon: <IconRobot size={22} aria-hidden="true" />,
  },
  ranked: {
    href: "/casino/solitaire-duel",
    icon: <IconTrophy size={22} aria-hidden="true" />,
  },
  dailyPuzzle: {
    href: "/play/daily-puzzle/play",
    icon: <IconPuzzle size={22} aria-hidden="true" />,
  },
  unlimited: {
    href: "/play/unlimited-puzzles/play",
    icon: <IconInfinity size={22} aria-hidden="true" />,
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
  const palette = PLAY_MODE_PALETTE[mode];
  const prefix = `playHub.lobby.${mode}`;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[color:var(--bg-page)] pb-24 text-[color:var(--text-primary)] md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_at_top,var(--lobby-glow),transparent_62%)]"
        style={{ ["--lobby-glow" as string]: palette.glow }}
      />
      <NavigationBar currentPath="/play" />

      <main className="relative mx-auto max-w-5xl px-4 pt-24 sm:px-6 md:pt-28">
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
          style={{
            borderColor: palette.line,
            backgroundImage: palette.surface,
          }}
          className="mt-4 overflow-hidden rounded-2xl border"
        >
          <div className="grid md:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
                  style={{
                    borderColor: palette.line,
                    backgroundColor: palette.glow,
                    color: palette.accent,
                  }}
                >
                  {meta.icon}
                </span>
                <div className="min-w-0">
                  <p
                    className="text-[10px] font-black uppercase tracking-[0.24em]"
                    style={{ color: palette.accent }}
                  >
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
                  style={{
                    backgroundColor: palette.accent,
                    color: "#04120f",
                  }}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-black transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {t(`${prefix}.cta`)}
                  <IconArrowRight size={16} aria-hidden="true" />
                </Link>
                {secondary}
              </div>

              <p className="mt-4 border-t border-white/8 pt-3 text-[11px] leading-relaxed text-white/40">
                {t(`${prefix}.note`)}
              </p>
            </div>

            <div
              className="relative order-first border-b md:order-none md:border-b-0 md:border-l"
              style={{ borderColor: palette.line }}
              data-testid={`play-lobby-${mode}-preview`}
            >
              <ModeTableau variant={mode} />
              <span
                className="absolute bottom-3 left-3 rounded-full border bg-[#04060f]/80 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] backdrop-blur-xs"
                style={{ borderColor: palette.line, color: palette.accent }}
              >
                {t(`playHub.cards.${mode}.tag`)}
              </span>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
