"use client";

// src/components/play/PlayHub.tsx
//
// THE PLAY HUB — six modes, three groups, six surfaces.
//
// Every card now opens with a short, looping preview of its OWN table
// (components/play/ModeTableau): the same Klondike furniture the game deals,
// in the mode's colour, playing the one move that defines the mode (stock to
// waste, a deal, a card climbing to a foundation, a two-seat race, a puzzle
// lift, an endless shuffle). The preview is SVG + CSS animation only, so the
// hub stays a single server render with no video payload.
//
// Colour is the second way the modes separate: ranked is emerald, solo cyan,
// AI violet, the daily challenge amber, the daily puzzle sky and unlimited
// puzzles fuchsia. Each card's surface, border, preview felt and CTA take that
// hue, and the groups sit under tinted section rules, so the page reads as
// three zones rather than one grid of identical boxes.
//
// Every href (and every figure) is unchanged: the cards still lead to their
// real lobbies, and the unlimited card still reads the server's allowance.

import Link from "next/link";
import type { CSSProperties } from "react";
import { IconArrowRight } from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import ModeTableau, { type TableauVariant } from "./ModeTableau";
import PuzzleAllowanceBadge from "./PuzzleAllowanceBadge";

import { useTranslation } from "../../hooks/useTranslation";
import {
  PLAY_MODE_GROUPS as GROUPS,
  PLAY_MODE_PALETTE as PALETTE,
} from "../../lib/playModePalette";

type ModeId = "solo" | "daily" | "ai" | "ranked" | "dailyPuzzle" | "unlimited";
type GroupId = "competitive" | "casual" | "puzzle";

type Mode = {
  id: ModeId;
  href: string;
  group: GroupId;
};

const MODES: readonly Mode[] = [
  { id: "solo", href: "/solitaire", group: "casual" },
  { id: "daily", href: "/daily", group: "casual" },
  { id: "ai", href: "/play/ai", group: "casual" },
  { id: "ranked", href: "/play/ranked", group: "competitive" },
  { id: "dailyPuzzle", href: "/play/daily-puzzle", group: "puzzle" },
  { id: "unlimited", href: "/play/unlimited-puzzles", group: "puzzle" },
];

const GROUP_DOT: Record<GroupId, string> = {
  competitive: "bg-[#00ffa3] shadow-[0_0_10px_rgba(0,255,163,0.7)]",
  casual: "bg-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.6)]",
  puzzle: "bg-[#38bdf8] shadow-[0_0_10px_rgba(56,189,248,0.6)]",
};

export default function PlayHub() {
  const { t } = useTranslation();

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04060f] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.12),transparent_60%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-40 top-[420px] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,rgba(232,121,249,0.10),transparent_65%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 top-[820px] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,rgba(0,255,163,0.09),transparent_65%)]"
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

        {GROUPS.map((group) => (
          <section
            key={group.id}
            aria-labelledby={`play-group-${group.id}`}
            data-testid={`play-group-${group.id}`}
            className="mt-10"
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${GROUP_DOT[group.id]}`}
              />
              <h2
                id={`play-group-${group.id}`}
                className="text-[11px] font-black uppercase tracking-[0.32em] text-white/45"
              >
                {t(`playHub.groups.${group.id}`)}
              </h2>
              <span
                aria-hidden="true"
                className="h-px flex-1 bg-gradient-to-r from-white/15 to-transparent"
              />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MODES.filter((mode) => group.modes.includes(mode.id)).map((mode) => {
                const palette = PALETTE[mode.id];
                const featured = mode.id === "ranked";

                return (
                  <Link
                    key={mode.id}
                    href={mode.href}
                    data-testid={`play-mode-${mode.id}`}
                    style={
                      {
                        "--mode-accent": palette.accent,
                        "--mode-line": palette.line,
                        "--mode-glow": palette.glow,
                        backgroundImage: palette.surface,
                        borderColor: palette.line,
                      } as CSSProperties
                    }
                    className={`group relative flex h-full flex-col overflow-hidden rounded-2xl border transition duration-200 hover:-translate-y-0.5 hover:border-[color:var(--mode-accent)] hover:shadow-[0_18px_44px_-18px_var(--mode-glow)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--mode-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#04060f] motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${
                      featured ? "sm:col-span-2 lg:col-span-3 sm:flex-row" : ""
                    }`}
                  >
                    <div
                      className={`relative aspect-[16/9] w-full shrink-0 overflow-hidden border-b border-[color:var(--mode-line)] ${
                        featured ? "sm:w-1/2 sm:border-b-0 sm:border-r" : ""
                      }`}
                    >
                      <ModeTableau variant={mode.id as TableauVariant} />
                      <span className="absolute bottom-3 left-3 rounded-full border border-[color:var(--mode-line)] bg-[#04060f]/80 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] text-[color:var(--mode-accent)] backdrop-blur-xs">
                        {t(`playHub.cards.${mode.id}.tag`)}
                      </span>
                    </div>

                    <div className="flex flex-1 flex-col p-4 sm:p-5">
                      <h3 className="text-lg font-black tracking-tight text-white">
                        {t(`playHub.cards.${mode.id}.title`)}
                      </h3>
                      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-white/60">
                        {t(`playHub.cards.${mode.id}.description`)}
                      </p>
                      <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-white/40">
                        {t(`playHub.cards.${mode.id}.meta`)}
                      </p>

                      {mode.id === "unlimited" && (
                        <span
                          data-testid="play-mode-unlimited-remaining"
                          className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fuchsia-200/85"
                        >
                          <PuzzleAllowanceBadge />
                        </span>
                      )}

                      <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-extrabold text-[color:var(--mode-accent)]">
                        {t(`playHub.cards.${mode.id}.cta`)}
                        <IconArrowRight
                          size={14}
                          aria-hidden="true"
                          className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                        />
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </main>

      <Footer />
    </div>
  );
}
