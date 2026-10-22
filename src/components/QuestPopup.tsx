"use client";

// src/components/QuestPopup.tsx
//
// The quest board as a POPUP — the full daily + weekly list opened from the
// corner widget (components/QuestWidget) on the home page and the games hub.
// /rewards still renders components/QuestBoard inline; this is the same board
// for a player who is mid-navigation and does not want to leave the lobby.
//
// ── What this component is allowed to decide ───────────────────────────────
//
// Nothing about the reward. It is handed the `useQuests()` result owned by the
// surface that opened it, and renders it. Progress, target, completion, the
// claimable flag and the credited amount all arrive from the server, exactly as
// they do on /rewards, so there is still ONE claim path in the app no matter
// how many surfaces open a board.
//
// ── The honest states ──────────────────────────────────────────────────────
//
// Still loading, failed, empty and the normal list are each rendered as
// themselves — a failed read is never shown as "no quests", and a player who is
// signed out never gets here at all (the widget renders nothing).
//
// ── Why it is portalled ────────────────────────────────────────────────────
//
// The widget lives inside page wrappers that animate transforms (the home page
// hero, the casino grid). A transformed ancestor becomes the containing block
// for `position: fixed` descendants and opens a new stacking context, so an
// overlay rendered in place would be sized to that wrapper and could be painted
// under the fixed navbar. Portalling to `document.body` puts the panel where
// `fixed inset-0` and `z-[100]` mean what they say.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  IconCalendarStats,
  IconCheck,
  IconCoin,
  IconRefresh,
  IconSwords,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";
import type { QuestView, UseQuests } from "../hooks/useQuests";
import { useQuestText } from "../hooks/useQuests";
import { useTranslation } from "../hooks/useTranslation";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The shared quest state, owned by the surface that opened the popup. */
  quests: UseQuests;
};

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function percentOf(quest: QuestView): number {
  const target = Number(quest.target);
  if (!Number.isFinite(target) || target <= 0) return 0;
  const progress = Math.max(0, Number(quest.progress) || 0);
  return Math.min(100, Math.round((progress / target) * 100));
}

export default function QuestPopup({ open, onClose, quests }: Props) {
  const { t } = useTranslation();
  const localise = useQuestText();
  const { board, loading, claimingId, claimedNow, error, load, claim } = quests;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Escape closes, the page behind stops scrolling, focus moves into the panel
  // and returns to whatever opened it. All three are restored on close.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      const previous = previouslyFocused.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, onClose]);

  // `open` only ever becomes true from a click, so the browser is guaranteed
  // here — no mount flag is needed, and a server render never reaches the portal
  // (the state starts closed).
  if (!open) return null;
  if (typeof document === "undefined") return null;

  const daily = board?.daily ?? [];
  const weekly = board?.weekly ?? [];
  const total = daily.length + weekly.length;

  const renderQuest = (quest: QuestView) => {
    const id = Number(quest.id);
    const percent = percentOf(quest);
    const claiming = claimingId === id;
    // Keyed translation with the server's own text as the fallback: a quest the
    // catalog ships before its locale strings land still reads correctly.
    const title = localise(`quests.defs.${quest.definitionId}.title`, quest.title);
    const description = localise(
      `quests.defs.${quest.definitionId}.description`,
      quest.description,
    );

    return (
      <li key={id || `${quest.periodType}-${quest.slot}`} className="h-full">
        <article
          className="flex h-full flex-col rounded-lg border border-[#00e5ff]/15 bg-[#030817]/60 p-3"
          data-testid={`quest-widget-quest-${id}`}
          data-claimable={quest.claimable ? "true" : "false"}
        >
          <div className="mb-1.5 flex items-start justify-between gap-2">
            <h4 className="text-sm font-bold text-[#c9f7ff]">{title}</h4>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-2 py-0.5 text-[11px] font-bold text-[#f5ff3b]">
              <IconCoin size={12} aria-hidden="true" />
              {formatCoins(quest.reward)}
            </span>
          </div>

          <p className="mb-2 flex-1 text-xs leading-relaxed text-[#9dd8ff]/80">
            {description}
          </p>

          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[#9dd8ff]">
            <span>{t("quests.progressLabel")}</span>
            <span className="text-[#c9f7ff]" data-testid={`quest-widget-progress-${id}`}>
              {t("quests.progressOf", {
                progress: formatCoins(quest.progress),
                target: formatCoins(quest.target),
              })}
            </span>
          </div>

          <div
            className="mb-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#00e5ff]/15"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("quests.progressBarLabel", { title })}
            data-testid={`quest-widget-progressbar-${id}`}
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
              className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-2.5 py-1 text-xs font-semibold text-[#c9f7ff]"
              data-testid={`quest-widget-claimed-${id}`}
            >
              <IconCheck size={12} aria-hidden="true" /> {t("quests.claimed")}
            </span>
          ) : quest.claimable ? (
            <button
              type="button"
              onClick={() => void claim(id)}
              disabled={claiming}
              data-testid={`quest-widget-claim-${id}`}
              className="inline-flex w-fit items-center justify-center rounded-lg border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-3 py-1.5 text-xs font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.3)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:cursor-wait disabled:opacity-60"
            >
              {claiming
                ? t("quests.claiming")
                : t("quests.claim", { reward: formatCoins(quest.reward) })}
            </button>
          ) : (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-[#9dd8ff]/25 bg-[#9dd8ff]/5 px-2.5 py-1 text-xs font-semibold text-[#9dd8ff]">
              {t("quests.inProgress")}
            </span>
          )}
        </article>
      </li>
    );
  };

  const renderSection = (
    key: "daily" | "weekly",
    list: QuestView[],
    heading: string,
    resets: string,
    Icon: typeof IconSwords,
  ) => (
    <div className="mb-5 last:mb-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#00e5ff]">
          <Icon size={16} aria-hidden="true" /> {heading}
        </h3>
        <span className="inline-flex items-center rounded-full border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9dd8ff]">
          {resets}
        </span>
      </div>

      {list.length === 0 ? (
        <p className="text-xs text-[#9dd8ff]/70" data-testid={`quest-widget-empty-${key}`}>
          {t("quests.empty")}
        </p>
      ) : (
        <ul
          role="list"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          data-testid={`quest-widget-list-${key}`}
        >
          {list.map(renderQuest)}
        </ul>
      )}
    </div>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      data-testid="quest-widget-overlay"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quest-widget-dialog-heading"
        tabIndex={-1}
        data-testid="quest-widget-dialog"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[#00e5ff]/40 bg-[#040d24] p-4 shadow-[0_0_40px_rgba(0,229,255,0.25)] outline-none sm:p-5"
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h2
              id="quest-widget-dialog-heading"
              className="flex items-center gap-2 text-lg font-bold text-[#00e5ff]"
            >
              <IconSwords size={20} aria-hidden="true" /> {t("quests.title")}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#c9f7ff]/75">
              {t("quests.dailyResets")} · {t("quests.weeklyResets")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("quests.close")}
            data-testid="quest-widget-close"
            className="shrink-0 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 p-2 text-[#d8fbff] transition hover:bg-[#00e5ff]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
          >
            <IconX size={16} aria-hidden="true" />
          </button>
        </div>

        <p className="mb-3 flex items-start gap-2 rounded-lg border border-[#ff4fd8]/25 bg-[#ff4fd8]/5 px-3 py-2 text-[11px] leading-relaxed text-[#c9f7ff]/85">
          <IconTrophy size={14} className="mt-0.5 shrink-0 text-[#ff4fd8]" aria-hidden="true" />
          <span>{t("quests.requiresHumanPvp")}</span>
        </p>

        {claimedNow !== null && (
          <p
            className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#f5ff3b]"
            role="status"
            data-testid="quest-widget-claimed-now"
          >
            <IconCheck size={15} aria-hidden="true" />
            {t("quests.claimedNow", { amount: formatCoins(claimedNow.amount) })}
          </p>
        )}

        {!board && loading ? (
          <p className="py-4 text-sm text-[#9dd8ff]/70" data-testid="quest-widget-loading">
            {t("quests.loading")}
          </p>
        ) : !board ? (
          <div className="py-2 text-sm text-[#c9f7ff]/80" data-testid="quest-widget-error">
            <p>{error ?? t("quests.loadError")}</p>
            <button
              type="button"
              onClick={() => void load()}
              data-testid="quest-widget-retry"
              className="mt-2 inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
            >
              <IconRefresh size={13} aria-hidden="true" /> {t("quests.retry")}
            </button>
          </div>
        ) : total === 0 ? (
          <p className="py-4 text-sm text-[#c9f7ff]/80" data-testid="quest-widget-empty">
            {t("quests.empty")}
          </p>
        ) : (
          <>
            {renderSection("daily", daily, t("quests.dailyTitle"), t("quests.dailyResets"), IconSwords)}
            {renderSection(
              "weekly",
              weekly,
              t("quests.weeklyTitle"),
              t("quests.weeklyResets"),
              IconCalendarStats,
            )}
            {error && (
              <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#ff4fd8]" role="alert">
                {error}
                <button
                  type="button"
                  onClick={() => void load()}
                  className="inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
                >
                  <IconRefresh size={12} aria-hidden="true" /> {t("quests.retry")}
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
