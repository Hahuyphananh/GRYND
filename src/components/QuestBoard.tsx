"use client";

// src/components/QuestBoard.tsx
//
// The quest board on /rewards: daily quests and weekly quests, side by side with
// the rest of the page's design language.
//
// ── What this component is allowed to decide ───────────────────────────────
//
// Nothing about the reward. Progress, target, completion and the claimed flag
// all arrive from `/api/quests`; the only interactive element is a claim button
// that posts the quest id. A button is rendered ONLY for a quest the server
// reports as `claimable` (complete AND unclaimed), so the UI cannot offer a
// payout the server would refuse.
//
// ── The honest states ─────────────────────────────────────────────────────
//
// Signed out, still loading, empty, refused/failed and the normal board are all
// rendered as themselves. A signed-out visitor is never shown a fabricated
// board, and a failed read is never rendered as "no quests".
//
// ── Eligibility ───────────────────────────────────────────────────────────
//
// Quests move only on completed human-vs-human matches (the server-side rule in
// src/lib/quests/settle.ts). The note under the heading says so, because a
// player who just beat the AI deserves to know why nothing moved.

import Link from "next/link";
import {
  IconCalendarStats,
  IconCheck,
  IconCoin,
  IconRefresh,
  IconSwords,
  IconTrophy,
} from "@tabler/icons-react";
import { useQuests } from "../hooks/useQuests";
import type { QuestView } from "../hooks/useQuests";
import { useTranslation } from "../hooks/useTranslation";

const CARD =
  "rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-5 backdrop-blur-sm sm:p-6";

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function percentOf(quest: QuestView): number {
  const target = Number(quest.target);
  if (!Number.isFinite(target) || target <= 0) return 0;
  const progress = Math.max(0, Number(quest.progress) || 0);
  return Math.min(100, Math.round((progress / target) * 100));
}

export default function QuestBoard() {
  const { t } = useTranslation();
  const {
    isLoaded,
    isSignedIn,
    board,
    loading,
    claimingId,
    claimedNow,
    error,
    load,
    claim,
  } = useQuests();

  // Keyed translations with the server's own text as the fallback: a quest the
  // catalog adds before its locale strings land still reads correctly.
  const localise = (key: string, fallback: string) => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  };

  const renderQuest = (quest: QuestView) => {
    const id = Number(quest.id);
    const percent = percentOf(quest);
    const claiming = claimingId === id;
    const title = localise(
      `quests.defs.${quest.definitionId}.title`,
      quest.title,
    );
    const description = localise(
      `quests.defs.${quest.definitionId}.description`,
      quest.description,
    );

    return (
      <li key={id || `${quest.periodType}-${quest.slot}`} className="h-full">
        <article
          className="flex h-full flex-col rounded-lg border border-[#00e5ff]/15 bg-[#030817]/60 p-4"
          data-testid={`quest-${id}`}
          data-claimable={quest.claimable ? "true" : "false"}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <h4 className="text-sm font-bold text-[#c9f7ff] sm:text-base">{title}</h4>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-2.5 py-1 text-[11px] font-bold text-[#f5ff3b]">
              <IconCoin size={12} aria-hidden="true" />
              {formatCoins(quest.reward)}
            </span>
          </div>

          <p className="mb-3 flex-1 text-xs leading-relaxed text-[#9dd8ff]/80">
            {description}
          </p>

          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[#9dd8ff]">
            <span>{t("quests.progressLabel")}</span>
            <span
              className="text-[#c9f7ff]"
              data-testid={`quest-progress-text-${id}`}
            >
              {t("quests.progressOf", {
                progress: formatCoins(quest.progress),
                target: formatCoins(quest.target),
              })}
            </span>
          </div>

          <div
            className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-[#00e5ff]/15"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("quests.progressBarLabel", { title })}
            data-testid={`quest-progress-${id}`}
          >
            <div
              className={[
                "h-full rounded-full transition-[width] duration-500",
                quest.completed
                  ? "bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800]"
                  : "bg-gradient-to-r from-[#00e5ff] to-[#7ef9ff]",
              ].join(" ")}
              style={{ width: `${percent}%` }}
            />
          </div>

          {quest.claimed ? (
            <span
              className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-3 py-1.5 text-xs font-semibold text-[#c9f7ff]"
              data-testid={`quest-claimed-${id}`}
            >
              <IconCheck size={13} aria-hidden="true" /> {t("quests.claimed")}
            </span>
          ) : quest.claimable ? (
            <button
              type="button"
              onClick={() => void claim(id)}
              disabled={claiming}
              data-testid={`quest-claim-${id}`}
              className="inline-flex w-fit items-center justify-center rounded-lg border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-4 py-2 text-xs font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.3)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:cursor-wait disabled:opacity-60"
            >
              {claiming
                ? t("quests.claiming")
                : t("quests.claim", { reward: formatCoins(quest.reward) })}
            </button>
          ) : (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-[#9dd8ff]/25 bg-[#9dd8ff]/5 px-3 py-1.5 text-xs font-semibold text-[#9dd8ff]">
              {t("quests.inProgress")}
            </span>
          )}
        </article>
      </li>
    );
  };

  const renderSection = (
    key: "daily" | "weekly",
    quests: QuestView[],
    heading: string,
    resets: string,
    Icon: typeof IconSwords,
  ) => (
    <div className="mb-8 last:mb-0">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="flex items-center gap-2 text-lg font-bold text-[#00e5ff]">
          <Icon size={18} aria-hidden="true" /> {heading}
        </h3>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9dd8ff]">
          {resets}
        </span>
      </div>

      {quests.length === 0 ? (
        <p
          className="text-sm text-[#9dd8ff]/70"
          data-testid={`quests-empty-${key}`}
        >
          {t("quests.empty")}
        </p>
      ) : (
        <ul
          role="list"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid={`quests-list-${key}`}
        >
          {quests.map(renderQuest)}
        </ul>
      )}
    </div>
  );

  const showBoard = Boolean(board) && isSignedIn;

  return (
    <section
      aria-labelledby="quests-heading"
      className={CARD}
      data-testid="quests-section"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2
          id="quests-heading"
          className="flex items-center gap-2 text-xl font-bold text-[#00e5ff] sm:text-2xl"
        >
          <IconSwords size={20} aria-hidden="true" /> {t("quests.title")}
        </h2>
        {board && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#f5ff3b]">
            <IconCoin size={12} aria-hidden="true" />
            {t("quests.available", { amount: formatCoins(claimableTotal(board.daily) + claimableTotal(board.weekly)) })}
          </span>
        )}
      </div>

      <p className="mb-5 flex items-start gap-2 rounded-lg border border-[#ff4fd8]/25 bg-[#ff4fd8]/5 px-3 py-2 text-xs leading-relaxed text-[#c9f7ff]/85">
        <IconTrophy size={15} className="mt-0.5 shrink-0 text-[#ff4fd8]" aria-hidden="true" />
        <span>{t("quests.requiresHumanPvp")}</span>
      </p>

      {claimedNow !== null && (
        <p
          className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#f5ff3b]"
          role="status"
          data-testid="quests-claimed-now"
        >
          <IconCheck size={16} aria-hidden="true" />
          {t("quests.claimedNow", { amount: formatCoins(claimedNow.amount) })}
        </p>
      )}

      {!isLoaded ? (
        <p className="text-sm text-[#9dd8ff]/70" data-testid="quests-loading">
          {t("quests.loading")}
        </p>
      ) : !isSignedIn ? (
        <p className="text-sm text-[#c9f7ff]/80" data-testid="quests-signed-out">
          <Link
            href="/sign-in"
            className="text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
          >
            {t("quests.signIn")}
          </Link>{" "}
          {t("quests.signedOutHint")}
        </p>
      ) : loading && !board ? (
        <p className="text-sm text-[#9dd8ff]/70" data-testid="quests-loading">
          {t("quests.loading")}
        </p>
      ) : !showBoard ? (
        <div className="text-sm text-[#c9f7ff]/80" data-testid="quests-error">
          <p>{error ?? t("quests.loadError")}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
            data-testid="quests-retry"
          >
            <IconRefresh size={13} aria-hidden="true" /> {t("quests.retry")}
          </button>
        </div>
      ) : (
        <>
          {board && board.daily.length === 0 && board.weekly.length === 0 ? (
            <p className="text-sm text-[#c9f7ff]/80" data-testid="quests-empty">
              {t("quests.empty")}
            </p>
          ) : (
            <>
              {renderSection(
                "daily",
                board?.daily ?? [],
                t("quests.dailyTitle"),
                t("quests.dailyResets"),
                IconSwords,
              )}
              {renderSection(
                "weekly",
                board?.weekly ?? [],
                t("quests.weeklyTitle"),
                t("quests.weeklyResets"),
                IconCalendarStats,
              )}
            </>
          )}

          {error && (
            <p
              className="mt-4 flex flex-wrap items-center gap-2 text-sm text-[#ff4fd8]"
              role="alert"
              data-testid="quests-error-inline"
            >
              {error}
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
              >
                <IconRefresh size={13} aria-hidden="true" /> {t("quests.retry")}
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Total coins sitting in claimable quests, for the header pill. */
function claimableTotal(quests: QuestView[]): number {
  return quests.reduce(
    (sum, quest) => (quest.claimable ? sum + (Number(quest.reward) || 0) : sum),
    0,
  );
}
