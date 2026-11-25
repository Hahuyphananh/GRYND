"use client";

// src/components/play/PlayHub.tsx
//
// THE PLAY HUB — eight modes, four zones.
//
// Ranked is now a ROW OF TWO equal cards (Solitaire Ranked and Puzzle Ranked);
// Practice pairs the two AI modes. Solo and the daily challenge stay casual,
// and the daily/unlimited puzzle surfaces keep their own zone. The existing
// strategic puzzle library entry sits directly under Practice, because it is a
// practice surface, not a replacement for either puzzle mode.
//
// Every href is unchanged for the six shipped cards; the two new cards point at
// their own lobbies and never at each other's mode. Colour, previews and the
// card language are the same palette every other card uses, so the new cards
// look like they always belonged.

import Link from "next/link";
import type { CSSProperties } from "react";
import { IconArrowRight } from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import ModeTableau, { type TableauVariant } from "./ModeTableau";
import { PageHeader } from "../ui";
import PuzzleAllowanceBadge from "./PuzzleAllowanceBadge";

import { useTranslation } from "../../hooks/useTranslation";
import {
  PLAY_MODE_GROUPS as GROUPS,
  PLAY_MODE_PALETTE as PALETTE,
} from "../../lib/playModePalette";

type ModeId =
  | "solo"
  | "daily"
  | "ai"
  | "ranked"
  | "puzzleRanked"
  | "puzzleAi"
  | "dailyPuzzle"
  | "unlimited";
type GroupId = "ranked" | "practice" | "casual" | "puzzle";

type Mode = {
  id: ModeId;
  href: string;
  group: GroupId;
};

const MODES: readonly Mode[] = [
  { id: "solo", href: "/solitaire", group: "casual" },
  { id: "daily", href: "/daily", group: "casual" },
  { id: "ai", href: "/play/ai", group: "practice" },
  { id: "ranked", href: "/play/ranked", group: "ranked" },
  { id: "puzzleRanked", href: "/play/puzzle-ranked", group: "ranked" },
  { id: "puzzleAi", href: "/play/puzzle-ai", group: "practice" },
  { id: "dailyPuzzle", href: "/play/daily-puzzle", group: "puzzle" },
  { id: "unlimited", href: "/play/unlimited-puzzles", group: "puzzle" },
];

// The previews are the SHIPPED ones; a new mode reuses the closest table rather
// than inventing a second animation language.
const TABLEAU: Record<ModeId, TableauVariant> = {
  solo: "solo",
  daily: "daily",
  ai: "ai",
  ranked: "ranked",
  puzzleRanked: "ranked",
  puzzleAi: "ai",
  dailyPuzzle: "dailyPuzzle",
  unlimited: "unlimited",
};

const GROUP_DOT: Record<GroupId, string> = {
  ranked: "bg-[#00ffa3] shadow-[0_0_10px_rgba(0,255,163,0.7)]",
  practice: "bg-[#c4b5fd] shadow-[0_0_10px_rgba(196,181,253,0.6)]",
  casual: "bg-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.6)]",
  puzzle: "bg-[#38bdf8] shadow-[0_0_10px_rgba(56,189,248,0.6)]",
};

export default function PlayHub() {
  const { t } = useTranslation();

  // The strategic puzzle library is a PRACTICE surface and the third card in
  // the Practice row — same shell, same preview language, its own route.
  const libraryPalette = PALETTE.dailyPuzzle;
  const libraryCard = (
    <Link
      href="/play/strategic-puzzles"
      data-testid="play-mode-strategic"
      style={
        {
          "--mode-accent": libraryPalette.accent,
          "--mode-line": libraryPalette.line,
          "--mode-glow": libraryPalette.glow,
          backgroundImage: libraryPalette.surface,
          borderColor: libraryPalette.line,
        } as CSSProperties
      }
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border transition duration-200 hover:-translate-y-0.5 hover:border-[color:var(--mode-accent)] hover:shadow-[0_18px_44px_-18px_var(--mode-glow)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--mode-accent)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div className="relative aspect-[16/9] w-full shrink-0 overflow-hidden border-b border-[color:var(--mode-line)]">
        <ModeTableau variant="dailyPuzzle" />
        <span className="absolute bottom-3 left-3 rounded-full border border-[color:var(--mode-line)] bg-[color:var(--bg-page)]/80 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] text-[color:var(--mode-accent)] backdrop-blur-xs">
          {t("playHub.cards.strategic.tag")}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <h3 className="text-lg font-black tracking-tight text-[color:var(--text-primary)]">
          {t("playHub.cards.strategic.title")}
        </h3>
        <p className="mt-1.5 flex-1 text-xs leading-relaxed text-[color:var(--text-secondary)]">
          {t("playHub.cards.strategic.description")}
        </p>
        <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
          {t("playHub.cards.strategic.meta")}
        </p>
        <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-extrabold text-[color:var(--mode-accent)]">
          {t("playHub.cards.strategic.cta")}
          <IconArrowRight
            size={14}
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          />
        </span>
      </div>
    </Link>
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-[color:var(--bg-page)] pb-24 text-[color:var(--text-primary)] md:pb-0">
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
        <PageHeader
          kicker={t("playHub.kicker")}
          title={t("playHub.title")}
          description={t("playHub.description")}
        />

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
                className="text-[11px] font-black uppercase tracking-[0.32em] text-[color:var(--text-muted)]"
              >
                {t(`playHub.groups.${group.id}`)}
              </h2>
              <span
                aria-hidden="true"
                className="h-px flex-1 bg-gradient-to-r from-white/15 to-transparent"
              />
            </div>

            {/* Ranked is the brief's 50/50 pair; the other zones pair up. The
                Practice zone has a third slot for the strategic library card,
                so it takes three columns on desktop. Mobile is always stacked
                and full width. */}
            <div
              className={`mt-4 grid gap-4 ${
                group.id === "practice"
                  ? "sm:grid-cols-2 lg:grid-cols-3"
                  : "sm:grid-cols-2"
              }`}
            >
              {MODES.filter((mode) => group.modes.includes(mode.id)).map((mode) => {
                const palette = PALETTE[mode.id];

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
                    className="group relative flex h-full flex-col overflow-hidden rounded-2xl border transition duration-200 hover:-translate-y-0.5 hover:border-[color:var(--mode-accent)] hover:shadow-[0_18px_44px_-18px_var(--mode-glow)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--mode-accent)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                  >
                    <div className="relative aspect-[16/9] w-full shrink-0 overflow-hidden border-b border-[color:var(--mode-line)]">
                      <ModeTableau variant={TABLEAU[mode.id]} />
                      <span className="absolute bottom-3 left-3 rounded-full border border-[color:var(--mode-line)] bg-[color:var(--bg-page)]/80 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] text-[color:var(--mode-accent)] backdrop-blur-xs">
                        {t(`playHub.cards.${mode.id}.tag`)}
                      </span>
                    </div>

                    <div className="flex flex-1 flex-col p-4 sm:p-5">
                      <h3 className="text-lg font-black tracking-tight text-[color:var(--text-primary)]">
                        {t(`playHub.cards.${mode.id}.title`)}
                      </h3>
                      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-[color:var(--text-secondary)]">
                        {t(`playHub.cards.${mode.id}.description`)}
                      </p>
                      <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
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

              {/* The strategic library is the third card of this same row. */}
              {group.id === "practice" && libraryCard}
            </div>
          </section>
        ))}
      </main>

      <Footer />
    </div>
  );
}
