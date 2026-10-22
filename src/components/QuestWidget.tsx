"use client";

// src/components/QuestWidget.tsx
//
// The quest board as a compact corner widget — the daily/weekly quests, in the
// top-LEFT of the page, under the navbar, mirroring the daily reward opposite it.
//
// ── Why a second surface ────────────────────────────────────────────────────
//
// Quest progress only moves on a settled human-vs-human match (lib/quests/
// settle.ts), so the moment a player needs to see it is where they decide what
// to play next: the home page and the games hub. /rewards remains the full
// explanation; this widget is the actionable summary, and it opens the whole
// board in a popup so nobody has to leave the lobby to claim.
//
// ── One source of truth ─────────────────────────────────────────────────────
//
// The read, the progress numbers, the claim and the credited amount all come
// from `useQuests` — the same hook /rewards uses — and the popup is handed that
// very state, so a claim made in the popup updates this widget's own counter.
// Nothing here does progress arithmetic on the player's behalf: `progress`,
// `target`, `completed` and `claimable` are the server's.
//
// ── Placement ───────────────────────────────────────────────────────────────
//
// `md:` and up: fixed to the viewport's top-left, below the navbar (which is
// fixed at h-16 / h-20 / h-24, so top-104px clears the tallest of the three),
// stacked BELOW the navbar (z-30 vs its z-40) and below the mobile menu (z-50)
// and the modals (z-100). Below `md:` the fixed card would cover the page it is
// meant to help, so the same element lays out inline at the top of the page
// content instead — right under the navbar, beside the daily reward.
//
// A signed-out visitor gets nothing: there are no quests without a player, and
// the navbar already owns the signed-out call to action.

import { useState } from "react";
import { IconCheck, IconCoin, IconRefresh, IconSwords } from "@tabler/icons-react";
import { useQuests } from "../hooks/useQuests";
import { useQuestText } from "../hooks/useQuests";
import { useTranslation } from "../hooks/useTranslation";
import type { QuestView } from "../hooks/useQuests";
import QuestPopup from "./QuestPopup";

// Inline under the navbar on small screens; pinned to the top-left corner on
// `md:` and up. The horizontal padding only applies while the widget is inline
// (the pages that mount it have no padding of their own at that point).
const POSITION_CLASS = [
  "mt-3 px-4 md:mt-0 md:px-0",
  "md:fixed md:left-4 md:top-[104px] md:z-30 md:w-72 md:max-w-[calc(100vw-2rem)]",
].join(" ");

const CARD =
  "rounded-xl border border-[#00e5ff]/40 bg-[#040d24]/90 px-4 py-3 shadow-[0_0_25px_rgba(0,229,255,0.16)] backdrop-blur-md";

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** How far along a quest is, as a 0–1 ratio. Server numbers only. */
function completionOf(quest: QuestView): number {
  const target = Number(quest.target);
  if (!Number.isFinite(target) || target <= 0) return 0;
  return Math.min(1, Math.max(0, Number(quest.progress) || 0) / target);
}

export default function QuestWidget() {
  const { t } = useTranslation();
  const localise = useQuestText();
  const quests = useQuests();
  const { isLoaded, isSignedIn, board, loading, error, load } = quests;
  const [open, setOpen] = useState(false);

  // No session yet (or no session at all) — nothing to show and nothing to
  // flash, so the corner stays empty.
  if (!isLoaded || !isSignedIn) return null;

  const all = [...(board?.daily ?? []), ...(board?.weekly ?? [])];
  const claimableCoins = all.reduce(
    (sum, quest) => (quest.claimable ? sum + (Number(quest.reward) || 0) : sum),
    0,
  );
  const done = all.filter((quest) => quest.completed).length;
  // The one quest worth naming: the closest to completion that has not paid yet,
  // so the corner always shows the player their shortest route to coins.
  const nextQuest =
    all
      .filter((quest) => !quest.completed && !quest.claimed)
      .sort((a, b) => completionOf(b) - completionOf(a))[0] ?? null;

  return (
    <div className={POSITION_CLASS} data-testid="quest-widget">
      <section aria-labelledby="quest-widget-heading" className={CARD}>
        <div className="flex items-center justify-between gap-2">
          <h2
            id="quest-widget-heading"
            className="flex items-center gap-1.5 text-sm font-bold text-[#00e5ff]"
          >
            <IconSwords size={16} aria-hidden="true" /> {t("quests.title")}
          </h2>
          {board && all.length > 0 && (
            <span className="rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#9dd8ff]">
              {t("quests.doneOf", { done, total: all.length })}
            </span>
          )}
        </div>

        {loading && !board ? (
          <p className="mt-2 text-xs text-[#9dd8ff]/70" aria-hidden="true">
            {t("quests.loading")}
          </p>
        ) : !board ? (
          <p className="mt-2 text-xs text-[#c9f7ff]/80">
            {t("quests.loadError")}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-1 inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
            >
              <IconRefresh size={12} aria-hidden="true" /> {t("quests.retry")}
            </button>
            {error ? (
              <span className="mt-1 block text-[11px] text-[#ff4fd8]">{error}</span>
            ) : null}
          </p>
        ) : all.length === 0 ? (
          <p className="mt-2 text-xs text-[#c9f7ff]/80">{t("quests.empty")}</p>
        ) : claimableCoins > 0 ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-[#f5ff3b]">
            <IconCoin size={13} aria-hidden="true" />
            {t("quests.available", { amount: formatCoins(claimableCoins) })}
          </p>
        ) : nextQuest ? (
          <div className="mt-2 space-y-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#c9f7ff]">
              <IconSwords size={12} className="shrink-0" aria-hidden="true" />
              {t("quests.nextUp", {
                title: localise(
                  `quests.defs.${nextQuest.definitionId}.title`,
                  nextQuest.title,
                ),
              })}
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-[#00e5ff]/15"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(completionOf(nextQuest) * 100)}
              aria-label={t("quests.progressBarLabel", { title: nextQuest.title })}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#00e5ff] to-[#7ef9ff] transition-[width] duration-500"
                style={{ width: `${Math.round(completionOf(nextQuest) * 100)}%` }}
              />
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9dd8ff]">
              {t("quests.progressOf", {
                progress: formatCoins(nextQuest.progress),
                target: formatCoins(nextQuest.target),
              })}
            </p>
          </div>
        ) : (
          <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-[#c9f7ff]/85">
            <IconCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            {t("quests.allDone")}
          </p>
        )}

        {board && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-testid="quest-widget-open"
            className="mt-2.5 w-full rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 py-2 text-xs font-bold uppercase tracking-wide text-[#d8fbff] transition hover:bg-[#00e5ff]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
          >
            {t("quests.viewAll")}
          </button>
        )}
      </section>

      <QuestPopup open={open} onClose={() => setOpen(false)} quests={quests} />
    </div>
  );
}
